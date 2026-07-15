import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { loadConfig, type AppConfig } from '../src/config.js';
import { PublicOAuthError, PublicOAuthFacade } from '../src/publicOAuth.js';

const REDIRECT_URI = 'http://127.0.0.1:3939/callback';
const RESOURCE = 'https://mcp.spala.ai/mcp';
const VERIFIER = 'v'.repeat(64);

function testConfig(statePath: string): AppConfig {
  return loadConfig({
    PUBLIC_BASE_URL: 'https://mcp.spala.ai',
    SPALA_API_BASE_URL: 'https://api.spala.ai',
    PUBLIC_OAUTH_ENCRYPTION_SECRET: 'public-oauth-replay-test-encryption-secret-32-bytes',
    PUBLIC_OAUTH_REPLAY_STATE_PATH: statePath,
  });
}

function createAuthorizationRequest(facade: PublicOAuthFacade) {
  const { clientId } = facade.register({ redirect_uris: [REDIRECT_URI] });
  const ticket = facade.createAuthorizationTicket({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    resource: RESOURCE,
    scope: 'api',
    state: 'test-state',
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(VERIFIER, 'utf8').digest('base64url'),
  });
  return { clientId, ticket };
}

function createGrant(facade: PublicOAuthFacade) {
  const { clientId, ticket } = createAuthorizationRequest(facade);
  const { callbackUrl } = facade.approve(ticket, 'dashboard-valid');
  const code = new URL(callbackUrl).searchParams.get('code');
  assert.ok(code);
  return {
    clientId,
    code,
    ticket,
    redeemInput: {
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
      code,
      code_verifier: VERIFIER,
    },
  };
}

function replayMarkerPaths(statePath: string): string[] {
  return readdirSync(statePath).flatMap(bucket => (
    readdirSync(join(statePath, bucket)).map(marker => join(statePath, bucket, marker))
  ));
}

type ReplayAction = 'approve' | 'redeem' | 'refresh';

async function consumeInProcess(
  config: AppConfig,
  action: ReplayAction,
  input: Record<string, unknown>,
  startAt: number,
): Promise<string> {
  const moduleUrl = pathToFileURL(resolve('dist/publicOAuth.js')).href;
  const script = `
    import { PublicOAuthFacade } from ${JSON.stringify(moduleUrl)};
    const delay = Number(process.env.START_AT) - Date.now();
    if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    try {
      const facade = new PublicOAuthFacade(JSON.parse(process.env.OAUTH_CONFIG));
      const input = JSON.parse(process.env.OAUTH_INPUT);
      if (process.env.OAUTH_ACTION === 'approve') facade.approve(input.request, input.dashboardToken);
      if (process.env.OAUTH_ACTION === 'redeem') facade.redeem(input);
      if (process.env.OAUTH_ACTION === 'refresh') {
        facade.refreshDashboardToken(input);
        facade.rotateRefresh(input);
      }
      process.stdout.write('success');
    } catch (error) {
      process.stdout.write(String(error?.error || error?.name || 'error'));
    }
  `;

  return new Promise<string>((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      env: {
        ...process.env,
        OAUTH_ACTION: action,
        OAUTH_CONFIG: JSON.stringify(config),
        OAUTH_INPUT: JSON.stringify(input),
        START_AT: String(startAt),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) {
        reject(new Error(`OAuth worker exited with ${code}: ${stderr}`));
        return;
      }
      resolveResult(stdout);
    });
  });
}

test('ticket and refresh replay claims are shared by facade instances', () => {
  const statePath = mkdtempSync(join(tmpdir(), 'public-oauth-shared-replay-'));
  try {
    const config = testConfig(statePath);
    const first = new PublicOAuthFacade(config);
    const second = new PublicOAuthFacade(config);
    const grant = createGrant(first);

    assert.throws(
      () => second.approve(grant.ticket, 'dashboard-valid'),
      (error: unknown) => error instanceof PublicOAuthError && error.error === 'invalid_request',
    );

    const tokens = first.redeem(grant.redeemInput);
    const refreshInput = {
      grant_type: 'refresh_token',
      client_id: grant.clientId,
      refresh_token: tokens.refreshToken,
    };
    assert.equal(first.refreshDashboardToken(refreshInput), 'dashboard-valid');
    first.rotateRefresh(refreshInput);
    assert.throws(
      () => second.refreshDashboardToken(refreshInput),
      (error: unknown) => error instanceof PublicOAuthError && error.error === 'invalid_grant',
    );
  } finally {
    rmSync(statePath, { recursive: true, force: true });
  }
});

test('a claim fails when its artifact expires during consumption', () => {
  const statePath = mkdtempSync(join(tmpdir(), 'public-oauth-expiry-boundary-'));
  const originalNow = Date.now;
  const startedAt = originalNow();
  try {
    Date.now = () => startedAt;
    const facade = new PublicOAuthFacade(testConfig(statePath));
    const grant = createGrant(facade);
    let clockRead = 0;
    Date.now = () => (clockRead++ === 0 ? startedAt + 59_000 : startedAt + 61_000);

    assert.throws(
      () => facade.redeem(grant.redeemInput),
      (error: unknown) => error instanceof PublicOAuthError && error.error === 'invalid_grant',
    );
    assert.equal(replayMarkerPaths(statePath).some(marker => basename(marker).startsWith('code.')), false);
  } finally {
    Date.now = originalNow;
    rmSync(statePath, { recursive: true, force: true });
  }
});

test('ticket, code, and refresh claims are atomic across processes and survive worker restart', async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'public-oauth-process-replay-'));
  try {
    const config = testConfig(statePath);
    const facade = new PublicOAuthFacade(config);
    const pending = createAuthorizationRequest(facade);
    const codeGrant = createGrant(facade);
    const refreshGrant = createGrant(facade);
    const tokens = facade.redeem(refreshGrant.redeemInput);
    const refreshInput = {
      grant_type: 'refresh_token',
      client_id: refreshGrant.clientId,
      refresh_token: tokens.refreshToken,
    };
    const startAt = Date.now() + 500;
    const [ticketResults, codeResults, refreshResults] = await Promise.all([
      Promise.all([
        consumeInProcess(config, 'approve', { request: pending.ticket, dashboardToken: 'dashboard-valid' }, startAt),
        consumeInProcess(config, 'approve', { request: pending.ticket, dashboardToken: 'dashboard-valid' }, startAt),
      ]),
      Promise.all([
        consumeInProcess(config, 'redeem', codeGrant.redeemInput, startAt),
        consumeInProcess(config, 'redeem', codeGrant.redeemInput, startAt),
      ]),
      Promise.all([
        consumeInProcess(config, 'refresh', refreshInput, startAt),
        consumeInProcess(config, 'refresh', refreshInput, startAt),
      ]),
    ]);
    assert.deepEqual(ticketResults.sort(), ['invalid_request', 'success']);
    assert.deepEqual(codeResults.sort(), ['invalid_grant', 'success']);
    assert.deepEqual(refreshResults.sort(), ['invalid_grant', 'success']);

    const afterRestart = await Promise.all([
      consumeInProcess(config, 'approve', { request: pending.ticket, dashboardToken: 'dashboard-valid' }, Date.now()),
      consumeInProcess(config, 'redeem', codeGrant.redeemInput, Date.now()),
      consumeInProcess(config, 'refresh', refreshInput, Date.now()),
    ]);
    assert.deepEqual(afterRestart, ['invalid_request', 'invalid_grant', 'invalid_grant']);
  } finally {
    rmSync(statePath, { recursive: true, force: true });
  }
});

test('replay state uses private permissions, hash-only markers, and removes expired claims', () => {
  const parent = mkdtempSync(join(tmpdir(), 'public-oauth-permissions-'));
  const statePath = join(parent, 'state');
  mkdirSync(statePath, { mode: 0o777 });
  chmodSync(statePath, 0o777);
  const originalNow = Date.now;
  const startedAt = originalNow();
  try {
    Date.now = () => startedAt;
    assert.throws(
      () => new PublicOAuthFacade(testConfig(statePath)),
      /could not be initialized securely/,
    );
    chmodSync(statePath, 0o700);
    const facade = new PublicOAuthFacade(testConfig(statePath));
    const first = createGrant(facade);
    facade.redeem(first.redeemInput);

    if (process.platform !== 'win32') {
      assert.equal(statSync(statePath).mode & 0o777, 0o700);
    }
    const initialMarkers = replayMarkerPaths(statePath);
    assert.equal(initialMarkers.length, 2);
    for (const markerPath of initialMarkers) {
      const marker = basename(markerPath);
      assert.match(marker, /^(ticket|code)\.[a-f0-9]{64}$/);
      if (process.platform !== 'win32') {
        assert.equal(statSync(markerPath).mode & 0o777, 0o600);
        assert.equal(statSync(dirname(markerPath)).mode & 0o777, 0o700);
      }
      const contents = readFileSync(markerPath, 'utf8');
      assert.doesNotMatch(`${marker}\n${contents}`, /dashboard-valid|v1\.|test-state/);
    }

    Date.now = () => startedAt + 7_201_000;
    const second = new PublicOAuthFacade(testConfig(statePath));
    const registration = second.register({ redirect_uris: [REDIRECT_URI] });
    const ticket = second.createAuthorizationTicket({
      client_id: registration.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      resource: RESOURCE,
      scope: 'api',
      state: 'cleanup-state',
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(VERIFIER, 'utf8').digest('base64url'),
    });
    second.approve(ticket, 'dashboard-valid');

    const remainingMarkers = replayMarkerPaths(statePath);
    assert.equal(remainingMarkers.length, 1);
    assert.ok(Number(basename(dirname(remainingMarkers[0]!))) > Math.floor(Date.now() / 1_000));
  } finally {
    Date.now = originalNow;
    rmSync(parent, { recursive: true, force: true });
  }
});

test('OAuth consumption fails closed when durable replay state becomes unavailable', () => {
  const statePath = mkdtempSync(join(tmpdir(), 'public-oauth-unavailable-'));
  try {
    const facade = new PublicOAuthFacade(testConfig(statePath));
    const { clientId } = facade.register({ redirect_uris: [REDIRECT_URI] });
    const ticket = facade.createAuthorizationTicket({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      resource: RESOURCE,
      scope: 'api',
      state: 'fail-closed-state',
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(VERIFIER, 'utf8').digest('base64url'),
    });
    rmSync(statePath, { recursive: true, force: true });

    assert.throws(
      () => facade.approve(ticket, 'dashboard-valid'),
      (error: unknown) => (
        error instanceof PublicOAuthError
        && error.error === 'server_error'
        && error.status === 503
      ),
    );
  } finally {
    rmSync(statePath, { recursive: true, force: true });
  }
});
