// Build-time floor. The monorepo deploy script reads this literal as the
// expected minimum, so keep it a plain string assignment.
export const PROJECT_INSTALLER_VERSION = '0.1.34';
export const INSTALLER_PACKAGE = '@spala-ai/mcp-install';
export const INSTALLER_MAINTENANCE_SPEC = '@spala-ai/mcp-install@latest';
export const INSTALLER_REGISTRY_URL = 'https://registry.npmjs.org/@spala-ai%2fmcp-install';
export const INSTALLER_REFRESH_INTERVAL_MS = 300_000;
const INSTALLER_REGISTRY_TIMEOUT_MS = 5_000;
const INSTALLER_REGISTRY_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const INSTALLER_RETRY_BASE_MS = 15_000;
const STRICT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const INSTALLER_UPDATE_POLICY = 'Check the project proxy installer version at the start of each working session. If it is older than testedVersion, ask the agent to reconnect the same bound project with public project_connect, execute the returned exact installer argv, and reload at a safe stopping point. New proxies check again every 15 minutes of tool activity and announce each newer tested version once per session. Do not read credential stores, start parallel OAuth, or automatically change projects. Unknown versions are not proof of being current. Native plugins and skills use their own update mechanisms.';

export type InstallerVersionSource = 'build-pin' | 'npm-registry';
export type InstallerRefreshResult =
  | { ok: true; version: string; changed: boolean }
  | { ok: false; reason: string };

type VersionParts = [number, number, number];

let current: { version: string; source: InstallerVersionSource } = { version: PROJECT_INSTALLER_VERSION, source: 'build-pin' };

function versionParts(value: unknown): VersionParts | null {
  if (typeof value !== 'string' || !STRICT_VERSION.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(part => Number.isSafeInteger(part)) ? parts as VersionParts : null;
}

function compareVersions(left: VersionParts, right: VersionParts): number {
  const index = left.findIndex((part, i) => part !== right[i]);
  return index < 0 ? 0 : left[index]! < right[index]! ? -1 : 1;
}

// The caret range of the floor, as npm reads ^floor: 1.x stays on major 1,
// 0.1.x stays on 0.1, and 0.0.x accepts only the floor itself.
function onFloorReleaseLine(candidate: VersionParts, floor: VersionParts): boolean {
  if (floor[0] > 0) return candidate[0] === floor[0];
  if (floor[1] > 0) return candidate[0] === 0 && candidate[1] === floor[1];
  return compareVersions(candidate, floor) === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Picks the newest stable, non-deprecated release on the floor's caret line
// that does not exceed the npm latest tag. Returns the floor when nothing
// newer qualifies and null when the registry metadata is unusable.
export function selectInstallerVersion(packument: unknown, minimumVersion: string = PROJECT_INSTALLER_VERSION): string | null {
  const floor = versionParts(minimumVersion);
  if (!floor || !isRecord(packument) || packument['name'] !== INSTALLER_PACKAGE) return null;
  const tags = packument['dist-tags'];
  const versions = packument['versions'];
  if (!isRecord(tags) || !isRecord(versions)) return null;
  const latest = versionParts(tags['latest']);
  if (!latest) return null;
  let selected = minimumVersion;
  let selectedParts = floor;
  for (const [version, metadata] of Object.entries(versions)) {
    const parts = versionParts(version);
    if (!parts || !isRecord(metadata) || metadata['deprecated']) continue;
    if (!onFloorReleaseLine(parts, floor) || compareVersions(parts, latest) > 0 || compareVersions(parts, selectedParts) <= 0) continue;
    selected = version;
    selectedParts = parts;
  }
  return selected;
}

export function projectInstallerVersion(): string {
  return current.version;
}

export function projectInstallerSpec(): string {
  return `${INSTALLER_PACKAGE}@${current.version}`;
}

export function projectInstallerVersionSource(): InstallerVersionSource {
  return current.source;
}

// Restores the build-time floor, as at process start.
export function resetProjectInstallerVersion(): void {
  current = { version: PROJECT_INSTALLER_VERSION, source: 'build-pin' };
}

class RegistryResponseTooLarge extends Error {}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new RegistryResponseTooLarge();
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RegistryResponseTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

// Never rejects. A failed refresh keeps the version currently served.
export async function refreshProjectInstallerVersion(fetchImpl: typeof fetch = globalThis.fetch): Promise<InstallerRefreshResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INSTALLER_REGISTRY_TIMEOUT_MS);
  try {
    const response = await fetchImpl(INSTALLER_REGISTRY_URL, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: `registry_status_${response.status}` };
    }
    let packument: unknown;
    try {
      packument = JSON.parse(await readBoundedBody(response, INSTALLER_REGISTRY_RESPONSE_LIMIT_BYTES));
    } catch (error) {
      if (error instanceof SyntaxError) return { ok: false, reason: 'invalid_registry_json' };
      throw error;
    }
    const version = selectInstallerVersion(packument);
    if (!version) return { ok: false, reason: 'invalid_registry_metadata' };
    const changed = version !== current.version;
    current = { version, source: 'npm-registry' };
    return { ok: true, version, changed };
  } catch (error) {
    if (error instanceof RegistryResponseTooLarge) return { ok: false, reason: 'registry_response_too_large' };
    return { ok: false, reason: controller.signal.aborted ? 'registry_timeout' : 'registry_unreachable' };
  } finally {
    clearTimeout(timeout);
  }
}

// Refreshes now, then every interval. After a failure it retries sooner,
// doubling from 15 s up to the interval. Logs only transitions.
export function followNpmInstallerReleases(options: {
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  log?: Pick<Console, 'log' | 'warn'>;
} = {}): () => void {
  const { fetchImpl = globalThis.fetch, intervalMs = INSTALLER_REFRESH_INTERVAL_MS, log = console } = options;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let announced: string | null = null;
  const tick = async () => {
    const result = await refreshProjectInstallerVersion(fetchImpl);
    if (stopped) return;
    if (result.ok) {
      if (failures > 0) log.log('[installer] npm registry check recovered');
      failures = 0;
      if (result.version !== announced) {
        announced = result.version;
        log.log(`[installer] project bind spec ${INSTALLER_PACKAGE}@${result.version} (npm registry)`);
      }
    } else {
      failures += 1;
      if (failures === 1) log.warn(`[installer] npm registry check failed (${result.reason}); keeping ${projectInstallerSpec()}`);
    }
    const delay = failures === 0 ? intervalMs : Math.min(intervalMs, INSTALLER_RETRY_BASE_MS * 2 ** (failures - 1));
    timer = setTimeout(() => void tick(), delay);
    timer.unref?.();
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export function installerUpdate(installedVersion?: string) {
  const testedVersion = projectInstallerVersion();
  let status = 'unknown';
  const installed = versionParts(installedVersion);
  const tested = versionParts(testedVersion);
  if (installed && tested) {
    const order = compareVersions(tested, installed);
    status = order === 0 ? 'current' : order > 0 ? 'update_available' : 'newer_than_tested';
  }
  return {
    package: INSTALLER_PACKAGE,
    installedVersion: installedVersion ?? null,
    testedVersion,
    status,
    policy: INSTALLER_UPDATE_POLICY,
    ...(status === 'update_available' ? { nextAction: { tool: 'project_connect', instruction: 'Reconnect the currently bound project with the current client, run the exact returned installer plan, then reload. Keep the existing project selection.' } } : {}),
  };
}
