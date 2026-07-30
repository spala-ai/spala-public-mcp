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
import { PUBLIC_MCP_SCOPE } from '../src/publicMcpContract.js';

const REDIRECT_URI = 'http://127.0.0.1:3939/callback';
const RESOURCE = 'https://mcp.spala.ai/mcp';
const A2A_RESOURCE = 'https://agent.spala.ai/a2a/jsonrpc';
const VERIFIER = 'v'.repeat(64);
const APPROVAL_PROOF = 'opaque-approval-proof-valid-for-tests';
const PLATFORM_TOKENS = {
  accessToken: 'opaque-platform-access-token-valid-for-tests',
  refreshToken: 'opaque-platform-refresh-token-valid-for-tests',
  expiresIn: 900,
};

function testConfig(statePath: string): AppConfig {
  return loadConfig({
    PUBLIC_BASE_URL: 'https://mcp.spala.ai',
    SPALA_API_BASE_URL: 'https://api.spala.ai',
    PUBLIC_OAUTH_ENCRYPTION_SECRET: 'public-oauth-replay-test-encryption-secret-32-bytes',
    PUBLIC_OAUTH_REPLAY_STATE_PATH: statePath,
    PUBLIC_MCP_PLATFORM_SERVICE_SECRET: 'public-oauth-test-platform-service-secret-32-bytes',
    SPALA_AGENT_A2A_RESOURCE_URL: A2A_RESOURCE,
  });
}

function createAuthorizationRequest(facade: PublicOAuthFacade) {
  const { clientId } = facade.register({ redirect_uris: [REDIRECT_URI] });
  const ticket = facade.createAuthorizationTicket({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    resource: RESOURCE,
    scope: PUBLIC_MCP_SCOPE,
    state: 'test-state',
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(VERIFIER, 'utf8').digest('base64url'),
  });
  return { clientId, ticket };
}

function createGrant(facade: PublicOAuthFacade) {
  const { clientId, ticket } = createAuthorizationRequest(facade);
  const approval = facade.prepareApproval(ticket, APPROVAL_PROOF);
  const { callbackUrl } = facade.approve(approval, 'platform-grant-code-valid-for-tests', 300);
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

type ReplayAction = 'approve' | 'redeem' | 'claim-crash';

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
      if (process.env.OAUTH_ACTION === 'approve') {
        const approval = facade.prepareApproval(input.request, input.approvalProof);
        facade.approve(approval, input.platformGrantCode, 300);
      }
      if (process.env.OAUTH_ACTION === 'redeem') {
        const redemption = await facade.redeem(input, async () => ({
          accessToken: 'opaque-platform-access-token-process-test',
          refreshToken: 'opaque-platform-refresh-token-process-test',
          expiresIn: 900,
        }));
        facade.wrapTokenSet(redemption.tokenSet, redemption.clientId);
        redemption.complete();
      }
      if (process.env.OAUTH_ACTION === 'claim-crash') {
        await facade.redeem(input, async () => {
          process.stdout.write('claimed');
          process.exit(0);
        });
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

test('approval retries are idempotent and a completed authorization code is single-use', async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'public-oauth-shared-replay-'));
  try {
    const config = testConfig(statePath);
    const first = new PublicOAuthFacade(config);
    const second = new PublicOAuthFacade(config);
    const grant = createGrant(first);

    const retried = second.approve(
      second.prepareApproval(grant.ticket, APPROVAL_PROOF),
      'platform-grant-code-valid-for-tests',
      300,
    );
    assert.equal(new URL(retried.callbackUrl).searchParams.get('code'), grant.code);
    assert.throws(
      () => second.prepareApproval(grant.ticket, 'different-approval-proof-value'),
      (error: unknown) => error instanceof PublicOAuthError && error.error === 'invalid_request',
    );

    const issued = await first.redeem(grant.redeemInput, async () => PLATFORM_TOKENS);
    const wrapped = first.wrapTokenSet(issued.tokenSet, issued.clientId);
    issued.complete();
    let repeatedExchangeCalled = false;
    await assert.rejects(
      second.redeem(grant.redeemInput, async () => {
        repeatedExchangeCalled = true;
        return PLATFORM_TOKENS;
      }),
      (error: unknown) => (
        error instanceof PublicOAuthError
        && error.error === 'invalid_grant'
        && /revoke.*reauthorize/i.test(error.message)
      ),
    );
    assert.equal(repeatedExchangeCalled, false);
    assert.notEqual(wrapped.accessToken, PLATFORM_TOKENS.accessToken);
    assert.notEqual(wrapped.refreshToken, PLATFORM_TOKENS.refreshToken);
    assert.match(wrapped.refreshToken, /^v1r\./);
    assert.deepEqual(first.delegatedAccessToken(wrapped.accessToken), {
      platformAccessToken: PLATFORM_TOKENS.accessToken,
      clientHash: createHash('sha256').update(grant.clientId).digest('hex'),
      resource: RESOURCE,
    });
  } finally {
    rmSync(statePath, { recursive: true, force: true });
  }
});

test('authorization code redemption permits omitted redirect_uri and binds any supplied value exactly', async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'public-oauth-optional-redirect-'));
  try {
    const facade = new PublicOAuthFacade(testConfig(statePath));
    const omittedGrant = createGrant(facade);
    const omittedInput = { ...omittedGrant.redeemInput };
    delete (omittedInput as Partial<typeof omittedInput>).redirect_uri;
    const omitted = await facade.redeem(omittedInput, async () => PLATFORM_TOKENS);
    facade.wrapTokenSet(omitted.tokenSet, omitted.clientId);
    omitted.complete();

    const mismatchGrant = createGrant(facade);
    await assert.rejects(
      facade.redeem({
        ...mismatchGrant.redeemInput,
        redirect_uri: 'http://127.0.0.1:4949/callback',
      }, async () => PLATFORM_TOKENS),
      (error: unknown) => error instanceof PublicOAuthError && error.error === 'invalid_grant',
    );
    const recovered = await facade.redeem(mismatchGrant.redeemInput, async () => PLATFORM_TOKENS);
    facade.wrapTokenSet(recovered.tokenSet, recovered.clientId);
    recovered.complete();
  } finally {
    rmSync(statePath, { recursive: true, force: true });
  }
});

test('authorization code redemption permits omitted resource and rejects a supplied mismatch', async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'public-oauth-optional-resource-'));
  try {
    const facade = new PublicOAuthFacade(testConfig(statePath));
    const omittedGrant = createGrant(facade);
    const omittedInput = { ...omittedGrant.redeemInput };
    delete (omittedInput as Partial<typeof omittedInput>).resource;
    const omitted = await facade.redeem(omittedInput, async () => PLATFORM_TOKENS);
    assert.equal(omitted.resource, RESOURCE);
    facade.wrapTokenSet(omitted.tokenSet, omitted.clientId, omitted.resource);
    omitted.complete();

    const mismatchGrant = createGrant(facade);
    await assert.rejects(
      facade.redeem({
        ...mismatchGrant.redeemInput,
        resource: 'https://agent.spala.ai/a2a/jsonrpc',
      }, async () => PLATFORM_TOKENS),
      (error: unknown) => error instanceof PublicOAuthError && error.error === 'invalid_grant',
    );
  } finally {
    rmSync(statePath, { recursive: true, force: true });
  }
});

test('a failed platform exchange reserves the exact code binding for a safe retry', async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'public-oauth-retryable-code-'));
  try {
    const facade = new PublicOAuthFacade(testConfig(statePath));
    const grant = createGrant(facade);
    await assert.rejects(
      facade.redeem(grant.redeemInput, async () => {
        throw new Error('temporary upstream failure');
      }),
      /temporary upstream failure/,
    );
    assert.equal(replayMarkerPaths(statePath).some(marker => basename(marker).startsWith('code.')), true);
    let exchangeInput: {
      platformGrantCode: string;
      clientHash: string;
    } | undefined;
    const redemption = await facade.redeem(grant.redeemInput, async input => {
      exchangeInput = input;
      return PLATFORM_TOKENS;
    });
    const tokens = facade.wrapTokenSet(redemption.tokenSet, redemption.clientId);
    redemption.complete();
    assert.equal(exchangeInput?.platformGrantCode, 'platform-grant-code-valid-for-tests');
    assert.match(exchangeInput?.clientHash || '', /^[a-f0-9]{64}$/);
    assert.match(tokens.refreshToken, /^v1r\./);
    assert.notEqual(tokens.refreshToken, PLATFORM_TOKENS.refreshToken);
    assert.notEqual(tokens.accessToken, PLATFORM_TOKENS.accessToken);
    assert.deepEqual(facade.delegatedAccessToken(tokens.accessToken), {
      platformAccessToken: PLATFORM_TOKENS.accessToken,
      clientHash: exchangeInput?.clientHash,
      resource: RESOURCE,
    });
    const validatedRefresh = facade.validateRefresh({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: grant.clientId,
      resource: RESOURCE,
      scope: PUBLIC_MCP_SCOPE,
    });
    assert.deepEqual({
      refreshToken: validatedRefresh.refreshToken,
      clientId: validatedRefresh.clientId,
      clientHash: validatedRefresh.clientHash,
    }, {
      refreshToken: PLATFORM_TOKENS.refreshToken,
      clientId: grant.clientId,
      clientHash: exchangeInput?.clientHash,
    });
    assert.match(validatedRefresh.resultId, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(validatedRefresh.resultExpiresAt > Math.floor(Date.now() / 1_000));
  } finally {
    rmSync(statePath, { recursive: true, force: true });
  }
});

test('a definitive platform rejection consumes the authorization code without a retry exchange', async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'public-oauth-definitive-code-failure-'));
  try {
    const facade = new PublicOAuthFacade(testConfig(statePath));
    const grant = createGrant(facade);
    await assert.rejects(
      facade.redeem(
        grant.redeemInput,
        async () => {
          throw new Error('definitive invalid grant');
        },
        () => false,
      ),
      /definitive invalid grant/,
    );

    let repeatedExchangeCalled = false;
    await assert.rejects(
      facade.redeem(grant.redeemInput, async () => {
        repeatedExchangeCalled = true;
        return PLATFORM_TOKENS;
      }),
      (error: unknown) => error instanceof PublicOAuthError && error.error === 'invalid_grant',
    );
    assert.equal(repeatedExchangeCalled, false);
  } finally {
    rmSync(statePath, { recursive: true, force: true });
  }
});

test('delegated refresh wrappers enforce client, resource, scope, integrity, and expiry', async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'public-oauth-refresh-wrapper-'));
  const originalNow = Date.now;
  const startedAt = originalNow();
  try {
    Date.now = () => startedAt;
    const config = {
      ...testConfig(statePath),
      publicOAuthClientLifetimeSeconds: 3_600,
    };
    const facade = new PublicOAuthFacade(config);
    const grant = createGrant(facade);
    const otherClient = facade.register({ redirect_uris: [REDIRECT_URI] });
    const redemption = await facade.redeem(grant.redeemInput, async () => PLATFORM_TOKENS);
    const wrapped = facade.wrapTokenSet(redemption.tokenSet, redemption.clientId);
    redemption.complete();
    const refreshInput = {
      grant_type: 'refresh_token',
      refresh_token: wrapped.refreshToken,
      client_id: grant.clientId,
      resource: RESOURCE,
      scope: PUBLIC_MCP_SCOPE,
    };

    assert.equal(facade.validateRefresh(refreshInput).refreshToken, PLATFORM_TOKENS.refreshToken);
    const tamperedParts = wrapped.refreshToken.split('.');
    tamperedParts[2] = `${tamperedParts[2]![0] === 'A' ? 'B' : 'A'}${tamperedParts[2]!.slice(1)}`;
    for (const invalid of [
      { ...refreshInput, client_id: otherClient.clientId },
      { ...refreshInput, resource: 'https://mcp.spala.ai/other' },
      { ...refreshInput, scope: 'other' },
      {
        ...refreshInput,
        refresh_token: tamperedParts.join('.'),
      },
    ]) {
      assert.throws(
        () => facade.validateRefresh(invalid),
        (error: unknown) => error instanceof PublicOAuthError,
      );
    }

    Date.now = () => startedAt + 3_601_000;
    assert.throws(
      () => facade.validateRefresh(refreshInput),
      (error: unknown) => error instanceof PublicOAuthError && error.error === 'invalid_client',
    );
  } finally {
    Date.now = originalNow;
    rmSync(statePath, { recursive: true, force: true });
  }
});

test('a delayed rotated-refresh retry returns the exact encrypted result without plaintext state', () => {
  const statePath = mkdtempSync(join(tmpdir(), 'public-oauth-refresh-result-'));
  const originalNow = Date.now;
  const startedAt = originalNow();
  try {
    Date.now = () => startedAt;
    const facade = new PublicOAuthFacade(testConfig(statePath));
    const { clientId } = facade.register({ redirect_uris: [REDIRECT_URI] });
    const original = facade.wrapTokenSet(PLATFORM_TOKENS, clientId);
    const refreshInput = {
      grant_type: 'refresh_token',
      refresh_token: original.refreshToken,
      client_id: clientId,
      resource: RESOURCE,
      scope: PUBLIC_MCP_SCOPE,
    };
    const accessExpiresAt = Math.floor(startedAt / 1_000) + 900;
    const rotatedPlatformTokens = {
      accessToken: 'opaque-delayed-refresh-access-token-value',
      refreshToken: 'opaque-delayed-refresh-token-value',
      expiresIn: 900,
      accessExpiresAt,
    };
    const first = facade.wrapRefreshTokenSet(
      rotatedPlatformTokens,
      facade.validateRefresh(refreshInput),
    );

    Date.now = () => startedAt + 5_000;
    const retried = facade.wrapRefreshTokenSet(
      { ...rotatedPlatformTokens, expiresIn: 895 },
      facade.validateRefresh(refreshInput),
    );
    assert.deepEqual(retried, first);
    assert.throws(
      () => facade.wrapRefreshTokenSet(
        {
          ...rotatedPlatformTokens,
          accessToken: 'different-platform-access-token-value',
          expiresIn: 895,
        },
        facade.validateRefresh(refreshInput),
      ),
      (error: unknown) => error instanceof PublicOAuthError && error.error === 'server_error',
    );

    const state = replayMarkerPaths(statePath).map(path => readFileSync(path, 'utf8')).join('\n');
    assert.doesNotMatch(state, /opaque-delayed-refresh-access-token-value/);
    assert.doesNotMatch(state, /opaque-delayed-refresh-token-value/);
    assert.doesNotMatch(state, new RegExp(first.accessToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(state, new RegExp(first.refreshToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    Date.now = originalNow;
    rmSync(statePath, { recursive: true, force: true });
  }
});

test('an unfinished exchange crossing local code expiry remains retryable only within platform grant TTL', async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'public-oauth-expiry-boundary-'));
  const originalNow = Date.now;
  const startedAt = originalNow();
  try {
    Date.now = () => startedAt;
    const facade = new PublicOAuthFacade(testConfig(statePath));
    const grant = createGrant(facade);
    await assert.rejects(
      facade.redeem(grant.redeemInput, async () => {
        Date.now = () => startedAt + 61_000;
        throw new Error('upstream result was not completed');
      }),
      /not completed/,
    );
    assert.equal(replayMarkerPaths(statePath).some(marker => basename(marker).startsWith('code.')), true);
    const recovered = await facade.redeem(grant.redeemInput, async () => PLATFORM_TOKENS);
    facade.wrapTokenSet(recovered.tokenSet, recovered.clientId);
    recovered.complete();
    Date.now = () => startedAt + 301_000;
    await assert.rejects(
      facade.redeem(grant.redeemInput, async () => PLATFORM_TOKENS),
      (error: unknown) => error instanceof PublicOAuthError && error.error === 'invalid_grant',
    );
  } finally {
    Date.now = originalNow;
    rmSync(statePath, { recursive: true, force: true });
  }
});

test('ticket and code claims are atomic across processes and survive worker restart', async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'public-oauth-process-replay-'));
  try {
    const config = testConfig(statePath);
    const facade = new PublicOAuthFacade(config);
    const pending = createAuthorizationRequest(facade);
    const codeGrant = createGrant(facade);
    const startAt = Date.now() + 500;
    const [ticketResults, codeResults] = await Promise.all([
      Promise.all([
        consumeInProcess(config, 'approve', {
          request: pending.ticket,
          approvalProof: APPROVAL_PROOF,
          platformGrantCode: 'platform-grant-code-process-test',
        }, startAt),
        consumeInProcess(config, 'approve', {
          request: pending.ticket,
          approvalProof: APPROVAL_PROOF,
          platformGrantCode: 'platform-grant-code-process-test',
        }, startAt),
      ]),
      Promise.all([
        consumeInProcess(config, 'redeem', codeGrant.redeemInput, startAt),
        consumeInProcess(config, 'redeem', codeGrant.redeemInput, startAt),
      ]),
    ]);
    assert.deepEqual(ticketResults.sort(), ['success', 'success']);
    assert.equal(codeResults.filter(result => result === 'success').length, 1);
    assert.equal(
      codeResults.filter(result => ['invalid_grant', 'temporarily_unavailable'].includes(result)).length,
      1,
    );

    const afterRestart = await Promise.all([
      consumeInProcess(config, 'approve', {
        request: pending.ticket,
        approvalProof: APPROVAL_PROOF,
        platformGrantCode: 'platform-grant-code-process-test',
      }, Date.now()),
      consumeInProcess(config, 'redeem', codeGrant.redeemInput, Date.now()),
    ]);
    assert.deepEqual(afterRestart, ['success', 'invalid_grant']);
  } finally {
    rmSync(statePath, { recursive: true, force: true });
  }
});

test('an unfinished owner crash recovers after a bounded lease and within the platform grant TTL', async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'public-oauth-owner-recovery-'));
  const originalNow = Date.now;
  const startedAt = originalNow();
  try {
    const config = {
      ...testConfig(statePath),
      publicMcpPlatformTimeoutMs: 100,
    };
    const facade = new PublicOAuthFacade(config);
    const grant = createGrant(facade);
    assert.equal(
      await consumeInProcess(config, 'claim-crash', grant.redeemInput, Date.now()),
      'claimed',
    );

    Date.now = () => startedAt + 3_000;
    const restarted = new PublicOAuthFacade(config);
    const recovered = await restarted.redeem(grant.redeemInput, async () => PLATFORM_TOKENS);
    const wrapped = restarted.wrapTokenSet(recovered.tokenSet, recovered.clientId);
    recovered.complete();
    assert.match(wrapped.accessToken, /^v1a\./);

    await assert.rejects(
      restarted.redeem(grant.redeemInput, async () => PLATFORM_TOKENS),
      (error: unknown) => error instanceof PublicOAuthError && error.error === 'invalid_grant',
    );
  } finally {
    Date.now = originalNow;
    rmSync(statePath, { recursive: true, force: true });
  }
});

test('replay state uses private permissions, hash-only markers, and removes expired claims', async () => {
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
    const redemption = await facade.redeem(first.redeemInput, async () => PLATFORM_TOKENS);
    facade.wrapTokenSet(redemption.tokenSet, redemption.clientId);
    redemption.complete();

    if (process.platform !== 'win32') {
      assert.equal(statSync(statePath).mode & 0o777, 0o700);
    }
    const initialMarkers = replayMarkerPaths(statePath);
    assert.equal(initialMarkers.length, 3);
    for (const markerPath of initialMarkers) {
      const marker = basename(markerPath);
      assert.match(marker, /^(ticket|code|code-state)\.[a-f0-9]{64}$/);
      if (process.platform !== 'win32') {
        assert.equal(statSync(markerPath).mode & 0o777, 0o600);
        assert.equal(statSync(dirname(markerPath)).mode & 0o777, 0o700);
      }
      const contents = readFileSync(markerPath, 'utf8');
      assert.doesNotMatch(`${marker}\n${contents}`, /platform-grant-code|v1\.|test-state/);
    }

    Date.now = () => startedAt + 7_201_000;
    const second = new PublicOAuthFacade(testConfig(statePath));
    const registration = second.register({ redirect_uris: [REDIRECT_URI] });
    const ticket = second.createAuthorizationTicket({
      client_id: registration.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      resource: RESOURCE,
      scope: PUBLIC_MCP_SCOPE,
      state: 'cleanup-state',
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(VERIFIER, 'utf8').digest('base64url'),
    });
    second.approve(
      second.prepareApproval(ticket, APPROVAL_PROOF),
      'platform-grant-code-cleanup-test',
      300,
    );

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
      scope: PUBLIC_MCP_SCOPE,
      state: 'fail-closed-state',
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(VERIFIER, 'utf8').digest('base64url'),
    });
    const approval = facade.prepareApproval(ticket, APPROVAL_PROOF);
    rmSync(statePath, { recursive: true, force: true });

    assert.throws(
      () => facade.approve(approval, 'platform-grant-code-unavailable-test', 300),
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

test('DCR accepts only verified loopback, hosted, and explicit native callback classes', () => {
  const statePath = mkdtempSync(join(tmpdir(), 'public-oauth-native-callbacks-'));
  try {
    const facade = new PublicOAuthFacade(testConfig(statePath));
    const allowed = [
      'http://localhost:43123/oauth/callback',
      'http://127.0.0.1:33418/callback',
      'https://claude.ai/api/mcp/auth_callback',
      'https://vscode.dev/redirect',
      'https://vertexaisearch.cloud.google.com/oauth-redirect',
      'https://vertexaisearch.cloud.google.com/static/oauth/oauth.html',
      'https://agentidentitycredentials.googleapis.com/v1alpha/projects/wide-memento-446116-s7/locations/us-central1/authProviders/spala-oauth/oauthcallback',
      'cursor://anysphere.cursor-mcp/oauth/callback',
      'vscode://github.copilot-chat/mcp/oauth/callback',
      'vscode-insiders://github.copilot-chat/mcp/oauth/callback',
      'claude://mcp/oauth/callback',
      'codex://mcp/oauth/callback',
    ];
    for (const redirectUri of allowed) {
      const registration = facade.register({ redirect_uris: [redirectUri] });
      assert.deepEqual(registration.redirectUris, [redirectUri]);
      assert.match(facade.createAuthorizationTicket({
        client_id: registration.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        resource: RESOURCE,
        scope: PUBLIC_MCP_SCOPE,
        state: 'native-callback-state',
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(VERIFIER, 'utf8').digest('base64url'),
      }), /^v1\./);
    }

    const cursor = facade.register({
      redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback'],
    });
    assert.throws(
      () => facade.createAuthorizationTicket({
        client_id: cursor.clientId,
        redirect_uri: 'cursor://anysphere.cursor-mcp/oauth/other',
        response_type: 'code',
        resource: RESOURCE,
        scope: PUBLIC_MCP_SCOPE,
        state: 'native-callback-state',
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(VERIFIER, 'utf8').digest('base64url'),
      }),
      (error: unknown) => error instanceof PublicOAuthError && error.error === 'invalid_request',
    );

    for (const redirectUri of [
      'https://evil.example/oauth/callback',
      'https://vscode.dev/redirect/other',
      'https://agentidentitycredentials.googleapis.com/v1alpha/projects/wide-memento-446116-s7/locations/us-central1/authProviders/spala-oauth/oauthcallback?next=https://evil.example',
      'https://agentidentitycredentials.googleapis.com/v1alpha/projects/wide-memento-446116-s7/locations/us-central1/authProviders/spala-oauth/oauthcallback/extra',
      'https://subdomain.agentidentitycredentials.googleapis.com/v1alpha/projects/wide-memento-446116-s7/locations/us-central1/authProviders/spala-oauth/oauthcallback',
      'gemini://mcp/oauth/callback',
      'cursor://anysphere.cursor-mcp/oauth/callback?next=https://evil.example',
      'vscode://github.copilot-chat/mcp/oauth/callback#fragment',
      'codex://user@oauth/callback',
      'codex://attacker.example/callback',
      'claude://attacker.example/oauth/callback',
      'vscode://attacker.example/mcp/oauth/callback',
      'claude://mcp:443/oauth/callback',
      'cursor:/oauth/callback',
    ]) {
      assert.throws(
        () => facade.register({ redirect_uris: [redirectUri] }),
        (error: unknown) => error instanceof PublicOAuthError && error.error === 'invalid_request',
        redirectUri,
      );
    }
  } finally {
    rmSync(statePath, { recursive: true, force: true });
  }
});

test('Gemini Enterprise confidential clients require their secret only at the token endpoint', async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'public-oauth-gemini-client-'));
  try {
    const facade = new PublicOAuthFacade(testConfig(statePath));
    const registration = facade.register({
      client_name: 'Google Gemini Enterprise',
      redirect_uris: [
        'https://vertexaisearch.cloud.google.com/oauth-redirect',
        'https://vertexaisearch.cloud.google.com/static/oauth/oauth.html',
      ],
      token_endpoint_auth_method: 'client_secret_post',
    });
    assert.equal(registration.tokenEndpointAuthMethod, 'client_secret_post');
    assert.match(registration.clientSecret ?? '', /^[A-Za-z0-9_-]{32}$/);

    const ticket = facade.createAuthorizationTicket({
      client_id: registration.clientId,
      redirect_uri: 'https://vertexaisearch.cloud.google.com/oauth-redirect',
      response_type: 'code',
      resource: A2A_RESOURCE,
      scope: PUBLIC_MCP_SCOPE,
      state: 'gemini-state',
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(VERIFIER, 'utf8').digest('base64url'),
    });
    const approval = facade.prepareApproval(ticket, APPROVAL_PROOF);
    const { callbackUrl } = facade.approve(approval, 'gemini-platform-grant-code', 300);
    const code = new URL(callbackUrl).searchParams.get('code');
    assert.ok(code);
    const redeemInput = {
      grant_type: 'authorization_code',
      client_id: registration.clientId,
      redirect_uri: 'https://vertexaisearch.cloud.google.com/oauth-redirect',
      resource: A2A_RESOURCE,
      code,
      code_verifier: VERIFIER,
    };
    await assert.rejects(
      facade.redeem({ ...redeemInput, client_secret: 'wrong-secret' }, async () => PLATFORM_TOKENS),
      (error: unknown) => error instanceof PublicOAuthError
        && error.error === 'invalid_client'
        && error.status === 401,
    );
    const redemption = await facade.redeem({
      ...redeemInput,
      client_secret: registration.clientSecret,
    }, async () => PLATFORM_TOKENS);
    assert.equal(redemption.resource, A2A_RESOURCE);
  } finally {
    rmSync(statePath, { recursive: true, force: true });
  }
});

test('OAuth resource binding accepts only the configured MCP and A2A resources', async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'public-oauth-canonical-resource-'));
  try {
    const facade = new PublicOAuthFacade(loadConfig({
      PUBLIC_BASE_URL: 'https://alias.example',
      SPALA_API_BASE_URL: 'https://api.spala.ai',
      PUBLIC_OAUTH_ENCRYPTION_SECRET: 'public-oauth-canonical-resource-test-secret',
      PUBLIC_OAUTH_REPLAY_STATE_PATH: statePath,
      PUBLIC_MCP_PLATFORM_SERVICE_SECRET: 'public-oauth-canonical-service-secret-32-bytes',
      SPALA_AGENT_A2A_RESOURCE_URL: A2A_RESOURCE,
    }));
    const { clientId } = facade.register({ redirect_uris: [REDIRECT_URI] });
    const input = {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: PUBLIC_MCP_SCOPE,
      state: 'canonical-resource-state',
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(VERIFIER, 'utf8').digest('base64url'),
    };
    assert.throws(
      () => facade.createAuthorizationTicket({ ...input, resource: 'https://alias.example/mcp' }),
      (error: unknown) => error instanceof PublicOAuthError && error.error === 'invalid_target',
    );
    assert.match(facade.createAuthorizationTicket({ ...input, resource: RESOURCE }), /^v1\./);
    const ticket = facade.createAuthorizationTicket({ ...input, resource: A2A_RESOURCE });
    const approval = facade.prepareApproval(ticket, APPROVAL_PROOF);
    const { callbackUrl } = facade.approve(
      approval,
      'a2a-platform-grant-code-valid-for-tests',
      300,
    );
    const code = new URL(callbackUrl).searchParams.get('code');
    assert.ok(code);
    const redemption = await facade.redeem({
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      resource: A2A_RESOURCE,
      code,
      code_verifier: VERIFIER,
    }, async () => PLATFORM_TOKENS);
    assert.equal(redemption.resource, A2A_RESOURCE);
    const wrapped = facade.wrapTokenSet(
      redemption.tokenSet,
      redemption.clientId,
      redemption.resource,
    );
    redemption.complete();
    assert.equal(facade.delegatedAccessToken(wrapped.accessToken).resource, A2A_RESOURCE);
    assert.equal(facade.validateRefresh({
      grant_type: 'refresh_token',
      refresh_token: wrapped.refreshToken,
      client_id: clientId,
      resource: A2A_RESOURCE,
      scope: PUBLIC_MCP_SCOPE,
    }).resource, A2A_RESOURCE);
    assert.throws(
      () => facade.validateRefresh({
        grant_type: 'refresh_token',
        refresh_token: wrapped.refreshToken,
        client_id: clientId,
        resource: RESOURCE,
        scope: PUBLIC_MCP_SCOPE,
      }),
      (error: unknown) => error instanceof PublicOAuthError && error.error === 'invalid_grant',
    );
  } finally {
    rmSync(statePath, { recursive: true, force: true });
  }
});

test('local OAuth source keeps platform credentials in distinct delegated wrappers', () => {
  const source = readFileSync(resolve('src/publicOAuth.ts'), 'utf8');
  assert.doesNotMatch(source, /dashboardToken|dashboard credential/);
  assert.match(source, /kind:\s*['"]delegated-refresh['"]/);
  assert.match(source, /prefix:\s*['"]v1d['"]\s*\|\s*['"]v1a['"]\s*\|\s*['"]v1r['"]/);
  assert.doesNotMatch(source, /issueTokens|publicOAuthAccessTokenLifetimeSeconds|publicOAuthRefreshTokenLifetimeSeconds/);
});
