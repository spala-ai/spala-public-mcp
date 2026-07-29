import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateTelemetryLines,
  configureTelemetry,
  drainTelemetry,
  recordTelemetry,
} from '../src/telemetry.js';

const POSIX = process.platform !== 'win32';

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'spala-telemetry-'));
}

function eventLines(directory: string): string[] {
  const files = readdirSync(directory).filter(name => name.startsWith('events-'));
  return files.flatMap(name => readFileSync(join(directory, name), 'utf8').trim().split('\n').filter(Boolean));
}

test('events are schema-filtered: only declared enum fields survive, adversarial values collapse', async () => {
  const directory = tempStateDir();
  try {
    configureTelemetry(join(directory, 'nested'));
    recordTelemetry('project_connect', {
      outcome: 'plan_issued',
      client: 'claude-code',
      tool: 'project_connect',
      ok: true,
      // Adversarial values in DECLARED string fields must collapse to the fallback.
      code: 'user@example.com',
      // Undeclared fields must be dropped entirely, whatever they contain.
      email: 'victim@example.com',
      ip: '203.0.113.7',
      token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
      path: '/Users/someone/secret',
    });
    recordTelemetry('oauth_token', { ok: false, grant: 'evil_grant_type', code: 'access_denied' });
    recordTelemetry('made_up_event', { ok: true });
    await drainTelemetry();

    const lines = eventLines(join(directory, 'nested'));
    assert.equal(lines.length, 2, 'unknown events are dropped');
    const serialized = lines.join('\n');
    assert.doesNotMatch(serialized, /example\.com|203\.0\.113|eyJ|\/Users\//, 'no identifier-like value reaches disk');

    const connect = JSON.parse(lines[0]!);
    assert.deepEqual(Object.keys(connect).sort(), ['client', 'code', 'event', 'ok', 'outcome', 'tool', 'ts'].sort());
    assert.equal(connect.code, 'other', 'out-of-enum value collapses to fallback');
    assert.equal(connect.client, 'claude-code');

    const token = JSON.parse(lines[1]!);
    assert.equal(token.grant, 'other', 'caller-controlled grant_type collapses to fallback');
    assert.equal(token.code, 'access_denied');
  } finally {
    configureTelemetry(null);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('recordTelemetry is a no-op when disabled', async () => {
  const directory = tempStateDir();
  try {
    configureTelemetry(null);
    recordTelemetry('manifest_fetch', {});
    await drainTelemetry();
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('pre-existing permissive directory and file are tightened to 0700/0600', { skip: !POSIX }, async () => {
  const parent = tempStateDir();
  const directory = join(parent, 'state');
  try {
    mkdirSync(directory, { mode: 0o755 });
    const day = new Date().toISOString().slice(0, 10);
    const file = join(directory, `events-${day}.ndjson`);
    writeFileSync(file, '', { mode: 0o644 });
    chmodSync(file, 0o644);
    configureTelemetry(directory);
    recordTelemetry('manifest_fetch', {});
    await drainTelemetry();

    assert.equal(lstatSync(directory).mode & 0o777, 0o700, 'directory tightened');
    assert.equal(lstatSync(file).mode & 0o777, 0o600, 'file tightened');
    assert.equal(eventLines(directory).length, 1);
  } finally {
    configureTelemetry(null);
    rmSync(parent, { recursive: true, force: true });
  }
});

test('a symlinked state directory disables telemetry instead of being followed', { skip: !POSIX }, async () => {
  const parent = tempStateDir();
  const real = join(parent, 'real');
  const link = join(parent, 'link');
  try {
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, link);
    configureTelemetry(link);
    recordTelemetry('manifest_fetch', {});
    await drainTelemetry();
    assert.deepEqual(readdirSync(real), [], 'no write through the symlink');
  } finally {
    configureTelemetry(null);
    rmSync(parent, { recursive: true, force: true });
  }
});

test('file size cap stops appends and the per-minute budget bounds event volume', async () => {
  const directory = tempStateDir();
  try {
    configureTelemetry(directory, { maxFileBytes: 200, maxEventsPerMinute: 3 });
    for (let index = 0; index < 10; index += 1) recordTelemetry('manifest_fetch', {});
    await drainTelemetry();
    const lines = eventLines(directory);
    assert.ok(lines.length <= 3, `per-minute budget enforced (${lines.length})`);
    const files = readdirSync(directory).filter(name => name.startsWith('events-'));
    const totalBytes = files.reduce((sum, name) => sum + statSync(join(directory, name)).size, 0);
    assert.ok(totalBytes <= 200, `file size cap respected (${totalBytes} bytes)`);
  } finally {
    configureTelemetry(null);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a zero pending-write budget drops every event instead of queueing', async () => {
  const directory = tempStateDir();
  try {
    configureTelemetry(directory, { maxPendingWrites: 0 });
    recordTelemetry('manifest_fetch', {});
    recordTelemetry('manifest_fetch', {});
    await drainTelemetry();
    assert.deepEqual(readdirSync(directory).filter(name => name.startsWith('events-')), []);
  } finally {
    configureTelemetry(null);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('retention prunes files older than the window and keeps exactly retentionDays calendar files', async () => {
  const directory = tempStateDir();
  try {
    writeFileSync(join(directory, 'events-2020-01-01.ndjson'), '{"ts":"2020-01-01T00:00:00.000Z","event":"manifest_fetch"}\n');
    writeFileSync(join(directory, 'unrelated.txt'), 'keep me\n');
    configureTelemetry(directory, { retentionDays: 1 });
    recordTelemetry('manifest_fetch', {});
    await drainTelemetry();
    const names = readdirSync(directory).sort();
    assert.equal(names.includes('events-2020-01-01.ndjson'), false, 'stale event file pruned');
    assert.equal(names.includes('unrelated.txt'), true, 'non-event files untouched');
    const eventFiles = names.filter(name => name.startsWith('events-'));
    assert.equal(eventFiles.length, 1, 'retentionDays=1 keeps only today');
  } finally {
    configureTelemetry(null);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a FIFO planted at the event path fails fast and disables telemetry instead of blocking', { skip: !POSIX }, async () => {
  const directory = tempStateDir();
  const day = new Date().toISOString().slice(0, 10);
  const fifoPath = join(directory, `events-${day}.ndjson`);
  try {
    try {
      execFileSync('mkfifo', [fifoPath]);
    } catch {
      return; // mkfifo unavailable on this system; nothing to probe.
    }
    configureTelemetry(directory);
    recordTelemetry('manifest_fetch', {});
    // The drain resolving at all (with no reader on the FIFO) proves open()
    // failed fast via O_NONBLOCK instead of blocking the queue forever.
    await drainTelemetry();
    recordTelemetry('manifest_fetch', {});
    await drainTelemetry();
    assert.equal(lstatSync(fifoPath).isFIFO(), true, 'the FIFO was not replaced');
  } finally {
    configureTelemetry(null);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('aggregateTelemetryLines counts access_denied, splits token grants, and skips malformed lines', () => {
  const aggregate = aggregateTelemetryLines([
    '{"ts":"2026-07-29T00:00:00.000Z","event":"manifest_fetch"}',
    '{"ts":"2026-07-29T00:01:00.000Z","event":"oauth_approval","ok":false,"code":"access_denied"}',
    '{"ts":"2026-07-29T00:02:00.000Z","event":"oauth_token","ok":true,"grant":"authorization_code"}',
    '{"ts":"2026-07-29T00:02:30.000Z","event":"oauth_token","ok":true,"grant":"refresh_token"}',
    '{"ts":"2026-07-29T00:03:00.000Z","event":"project_connect","outcome":"plan_issued","client":"cursor"}',
    '{"ts":"2026-07-29T00:04:00.000Z","event":"spala_start","ok":false,"phase":"startup_failed","code":"upstream_unavailable"}',
    'not json at all',
    '',
  ]);
  assert.equal(aggregate.total, 6);
  assert.equal(aggregate.failureCodes['oauth_approval:access_denied'], 1, 'the allow_access metric works');
  assert.equal(aggregate.failureCodes['spala_start:upstream_unavailable'], 1, 'failures with ok:false are counted');
  assert.equal(aggregate.outcomes['oauth_token:authorization_code'], 1);
  assert.equal(aggregate.outcomes['oauth_token:refresh_token'], 1);
  assert.equal(aggregate.outcomes['project_connect:plan_issued'], 1);
  assert.equal(aggregate.clients['cursor'], 1);
  assert.equal(aggregate.phases['startup_failed'], 1);

  const since = aggregateTelemetryLines([
    '{"ts":"2026-07-29T00:00:00.000Z","event":"manifest_fetch"}',
    '{"ts":"2026-07-29T00:05:00.000Z","event":"manifest_fetch"}',
  ], '2026-07-29T00:04:00.000Z');
  assert.equal(since.total, 1);
});
