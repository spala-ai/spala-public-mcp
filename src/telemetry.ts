import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

type TelemetryFields = Record<string, string | boolean | undefined>;

// Every recordable event has a fixed schema. String fields accept ONLY the
// listed enum values; anything else collapses to the list's final fallback
// member. Unknown events and undeclared fields are dropped entirely, so no
// caller-controlled or user-identifying string can ever reach disk.
const OAUTH_ERROR_CODES = [
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'access_denied',
  'temporarily_unavailable',
  'server_error',
  'other',
] as const;

const API_ERROR_CODES = [
  'payment_required',
  'plan_restricted',
  'organization_selection_required',
  'organization_required',
  'authentication',
  'forbidden',
  'not_found',
  'rate_limited',
  'upstream_unavailable',
  'invalid_project_mcp_handoff',
  'project_token_exchange_failed',
  'project_mcp_enable_failed',
  'project_mcp_preparation_failed',
  'project_agent_instruction_failed',
  'other',
] as const;

const AUTH_TOOL_NAMES = [
  'spala_start',
  'account_status',
  'account_setup',
  'organization_create',
  'project_list',
  'project_create',
  'project_connect',
  'project_select',
  'project_get_mcp_manifest',
  'project_get_public_context',
  'other',
] as const;

const EVENT_SCHEMAS: Record<string, Record<string, 'boolean' | readonly string[]>> = {
  manifest_fetch: {},
  mcp_auth_challenge: { invalidToken: 'boolean', source: ['http', 'tool', 'other'], tool: AUTH_TOOL_NAMES },
  rate_limited: { surface: ['mcp', 'oauth', 'other'] },
  oauth_register: { ok: 'boolean', code: OAUTH_ERROR_CODES },
  oauth_authorize_redirect: { ok: 'boolean', code: OAUTH_ERROR_CODES },
  oauth_approval: { ok: 'boolean', code: OAUTH_ERROR_CODES },
  oauth_token: {
    ok: 'boolean',
    grant: ['authorization_code', 'refresh_token', 'other'],
    code: OAUTH_ERROR_CODES,
  },
  spala_start: {
    ok: 'boolean',
    phase: [
      'account_setup_required',
      'project_choice_required',
      'project_name_required',
      'organization_choice_required',
      'billing_required',
      'startup_failed',
      'other',
    ],
    code: API_ERROR_CODES,
  },
  project_create: { ok: 'boolean', code: API_ERROR_CODES },
  project_connect: {
    ok: 'boolean',
    outcome: [
      'plan_issued',
      'client_selection_required',
      'mcp_not_ready',
      'project_not_found',
      'auth_required',
      'error',
      'other',
    ],
    client: ['codex', 'roo', 'claude-code', 'cursor', 'other'],
    tool: ['project_connect', 'project_select', 'other'],
    code: API_ERROR_CODES,
  },
};

type TelemetryOptions = {
  maxFileBytes?: number;
  maxEventsPerMinute?: number;
  maxPendingWrites?: number;
  retentionDays?: number;
};

const DEFAULT_OPTIONS: Required<TelemetryOptions> = {
  maxFileBytes: 64 * 1024 * 1024,
  maxEventsPerMinute: 120,
  maxPendingWrites: 500,
  retentionDays: 30,
};

const EVENT_FILE_PATTERN = /^events-(\d{4}-\d{2}-\d{2})\.ndjson$/;

let stateDirectory: string | null = null;
let options: Required<TelemetryOptions> = DEFAULT_OPTIONS;
let disabledByFailure = false;
let warnedAboutFailure = false;
let pendingCount = 0;
let pendingTail: Promise<void> = Promise.resolve();
let lastRetentionDay = '';
const minuteBuckets = new Map<string, { windowStart: number; count: number }>();

/**
 * Point telemetry at a state directory, or disable it with null. Events are
 * appended as NDJSON to one file per UTC day. Writes are fire-and-forget and
 * bounded: telemetry must never fail, slow, or exhaust the service.
 */
export function configureTelemetry(directory: string | null, overrides: TelemetryOptions = {}): void {
  stateDirectory = directory;
  options = { ...DEFAULT_OPTIONS, ...overrides };
  disabledByFailure = false;
  warnedAboutFailure = false;
  pendingCount = 0;
  lastRetentionDay = '';
  minuteBuckets.clear();
}

function disableAfterFailure(reason: string, error?: unknown): void {
  disabledByFailure = true;
  if (!warnedAboutFailure) {
    warnedAboutFailure = true;
    // Log only the error code, never the message: fs error messages embed
    // absolute filesystem paths.
    const code = (error as { code?: unknown } | undefined)?.code;
    const detail = typeof code === 'string' ? ` [${code}]` : '';
    console.warn(`[telemetry] disabled (${reason})${detail}`);
  }
}

function ownedByProcess(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

async function ensureDirectory(directory: string): Promise<boolean> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    disableAfterFailure('state path is not a real directory');
    return false;
  }
  if (!ownedByProcess(info.uid)) {
    disableAfterFailure('state directory is not owned by the service user');
    return false;
  }
  if ((info.mode & 0o777) !== 0o700) await chmod(directory, 0o700);
  return true;
}

async function pruneOldFiles(directory: string, today: string): Promise<void> {
  if (lastRetentionDay === today) return;
  lastRetentionDay = today;
  // Keep exactly retentionDays calendar files including today.
  const cutoff = new Date(Date.parse(`${today}T00:00:00.000Z`) - (options.retentionDays - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const entries = await readdir(directory);
  for (const name of entries) {
    const match = EVENT_FILE_PATTERN.exec(name);
    if (match && match[1]! < cutoff) {
      await unlink(join(directory, name)).catch(() => {});
    }
  }
}

async function appendLine(directory: string, day: string, line: string): Promise<void> {
  if (!(await ensureDirectory(directory))) return;
  await pruneOldFiles(directory, day);
  // O_NOFOLLOW makes a symlinked event file fail the open instead of being
  // followed; O_NONBLOCK makes a FIFO planted at the event path fail fast
  // (ENXIO) instead of blocking open() and wedging the drain.
  const flags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY
    | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0);
  const handle = await open(join(directory, `events-${day}.ndjson`), flags, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || !ownedByProcess(info.uid)) {
      disableAfterFailure('event file is not a regular owned file');
      return;
    }
    if ((info.mode & 0o777) !== 0o600) await handle.chmod(0o600);
    if (info.size + line.length > options.maxFileBytes) return;
    await handle.write(line);
  } finally {
    await handle.close();
  }
}

function underMinuteBudget(event: string, now: number): boolean {
  const windowStart = Math.floor(now / 60_000);
  const bucket = minuteBuckets.get(event);
  if (!bucket || bucket.windowStart !== windowStart) {
    minuteBuckets.set(event, { windowStart, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= options.maxEventsPerMinute;
}

export function recordTelemetry(event: string, fields: TelemetryFields = {}): void {
  if (!stateDirectory || disabledByFailure) return;
  const schema = EVENT_SCHEMAS[event];
  if (!schema) return;
  const now = Date.now();
  if (!underMinuteBudget(event, now)) return;
  if (pendingCount >= options.maxPendingWrites) return;

  const entry: Record<string, string | boolean> = {};
  for (const [key, expected] of Object.entries(schema)) {
    const raw = fields[key];
    if (raw === undefined) continue;
    if (expected === 'boolean') {
      if (typeof raw === 'boolean') entry[key] = raw;
      continue;
    }
    entry[key] = typeof raw === 'string' && expected.includes(raw) ? raw : expected[expected.length - 1]!;
  }

  const timestamp = new Date(now).toISOString();
  const line = `${JSON.stringify({ ts: timestamp, event, ...entry })}\n`;
  const directory = stateDirectory;
  pendingCount += 1;
  pendingTail = pendingTail
    .then(() => appendLine(directory, timestamp.slice(0, 10), line))
    .catch(error => disableAfterFailure('write failed', error))
    .finally(() => { pendingCount -= 1; });
}

/**
 * Await queued appends until the queue is quiescent — events enqueued while
 * draining (for example by requests finishing during shutdown) are included,
 * not lost to a one-shot snapshot of the promise chain.
 */
export async function drainTelemetry(): Promise<void> {
  let observedTail: Promise<void>;
  do {
    observedTail = pendingTail;
    await observedTail;
  } while (observedTail !== pendingTail);
}

export type TelemetryAggregate = {
  total: number;
  events: Record<string, number>;
  outcomes: Record<string, number>;
  clients: Record<string, number>;
  phases: Record<string, number>;
  failureCodes: Record<string, number>;
  firstTs?: string;
  lastTs?: string;
};

function bump(bucket: Record<string, number>, key: string): void {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

/** Aggregate NDJSON event lines into funnel counters. Malformed lines are skipped. */
export function aggregateTelemetryLines(lines: Iterable<string>, since?: string): TelemetryAggregate {
  const aggregate: TelemetryAggregate = { total: 0, events: {}, outcomes: {}, clients: {}, phases: {}, failureCodes: {} };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const event = typeof parsed['event'] === 'string' ? parsed['event'] : undefined;
    const ts = typeof parsed['ts'] === 'string' ? parsed['ts'] : undefined;
    if (!event || (since && ts && ts < since)) continue;
    aggregate.total += 1;
    bump(aggregate.events, event);
    if (ts) {
      if (!aggregate.firstTs || ts < aggregate.firstTs) aggregate.firstTs = ts;
      if (!aggregate.lastTs || ts > aggregate.lastTs) aggregate.lastTs = ts;
    }
    const outcome = parsed['outcome'];
    if (typeof outcome === 'string') bump(aggregate.outcomes, `${event}:${outcome}`);
    const grant = parsed['grant'];
    if (typeof grant === 'string') bump(aggregate.outcomes, `${event}:${grant}`);
    const client = parsed['client'];
    if (typeof client === 'string') bump(aggregate.clients, client);
    const phase = parsed['phase'];
    if (typeof phase === 'string') bump(aggregate.phases, phase);
    const code = parsed['code'];
    if (typeof code === 'string' && parsed['ok'] === false) bump(aggregate.failureCodes, `${event}:${code}`);
  }
  return aggregate;
}
