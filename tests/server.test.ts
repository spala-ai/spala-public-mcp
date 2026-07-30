import assert from 'node:assert/strict';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const nativeFetch = globalThis.fetch;
const localInstallerRoot = process.env['SPALA_MCP_INSTALLER_ROOT']?.trim();
const upstreamCalls: Array<{
  url: URL;
  method: string;
  authorization: string;
  serviceAuthentication: string;
  body?: string;
}> = [];
const platformServiceSecret = 'server-test-public-mcp-platform-service-secret';
type Account = 'valid' | 'plan' | 'new';
const dashboardAccounts = new Map([
  ['dashboard-valid', 'valid'],
  ['dashboard-plan', 'plan'],
  ['dashboard-new', 'new'],
] as const);
type DelegatedCredential = {
  account: Account;
  clientHash: string;
  familyId: string;
};
const approvalProofs = new Map<string, {
  request: string;
  account: Account;
  clientHash?: string;
  grantCode?: string;
}>();
const platformGrants = new Map<string, { account: Account; clientHash: string }>();
const accessCredentials = new Map<string, DelegatedCredential>();
const refreshCredentials = new Map<string, DelegatedCredential>();
const usedPlatformGrants = new Set<string>();
const refreshRetryCredentials = new Map<string, {
  credential: DelegatedCredential;
  tokens: ReturnType<typeof issuePlatformCredentials>;
  retries: number;
}>();
const allRawPlatformTokens = new Set<string>();
const transientPlatformRoutes = new Set<string>();
const networkFailurePlatformRoutes = new Set<string>();
const ambiguousPlatformRoutes = new Set<string>();
const revokedAccessTokens = new Set<string>();
const runtimeRevokedAccessTokens = new Set<string>();
const disabledPrincipalAccessTokens = new Set<string>();
const insufficientScopeAccessTokens = new Set<string>();
const projectConfigFailures = new Set<string>();
const temporaryProjectToken = 'project-entry-token';
const builderJwtSecret = 'server-test-builder-jwt-secret';
const builderProjectToken = issueBuilderToken('root');
const runtimeBuilderProjectToken = issueBuilderToken('project-1');
const authorizedProjectScope = 'builder,project';
const projectUrl = 'https://project-one.example';
const sharedRuntimeOrigin = 'https://shared-runtime.example';
const sharedRuntimeSlug = 'p123';
const canonicalProjectMcpUrl = `${sharedRuntimeOrigin}/${sharedRuntimeSlug}/mcp/?scope=builder%2Cproject`;
const canonicalProjectManifestUrl = `${sharedRuntimeOrigin}/${sharedRuntimeSlug}/mcp/install-manifest?scope=builder%2Cproject`;
const bootstrapConsumeUrl = `${sharedRuntimeOrigin}/${sharedRuntimeSlug}/mcp/agent-instructions/mcp_agent_test/consume`;
const installerProjectAccessToken = 'installer-only-project-access-token';
const installerProjectAccessExpiresAt = '2099-10-01T00:00:00.000Z';
let bootstrapConsumeCount = 0;
let newAccountProfile: { firstName: string; lastName: string } | undefined;
let newAccountOrganization: { id: string; name: string } | undefined;
let credentialSequence = 0;
let platformClockOffsetMs = 0;
let tokenIssueGate: {
  started: ReturnType<typeof deferred<void>>;
  release: ReturnType<typeof deferred<void>>;
} | undefined;
const replayStatePath = mkdtempSync(join(tmpdir(), 'mcp-spala-ai-server-replay-'));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function issuePlatformCredentials(
  account: Account,
  clientHash: string,
  familyId = `delegated-family-${credentialSequence + 1}`,
) {
  credentialSequence += 1;
  const accessToken = `opaque-public-access-${credentialSequence}-credential`;
  const refreshToken = `opaque-public-refresh-${credentialSequence}-credential`;
  const credential = { account, clientHash, familyId };
  accessCredentials.set(accessToken, credential);
  refreshCredentials.set(refreshToken, credential);
  allRawPlatformTokens.add(accessToken);
  allRawPlatformTokens.add(refreshToken);
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 900,
    access_expires_at: new Date(Date.now() + platformClockOffsetMs + 900_000).toISOString(),
    token_type: 'Bearer',
    resource: 'https://mcp.spala.ai/mcp',
    audience: 'https://mcp.spala.ai/mcp',
    scope: 'api',
  };
}

function revokeCredentialFamily(familyId: string): void {
  for (const [token, credential] of accessCredentials) {
    if (credential.familyId === familyId) accessCredentials.delete(token);
  }
  for (const [token, credential] of refreshCredentials) {
    if (credential.familyId === familyId) refreshCredentials.delete(token);
  }
  for (const [token, retry] of refreshRetryCredentials) {
    if (retry.credential.familyId === familyId) refreshRetryCredentials.delete(token);
  }
}

function latestDelegatedAccessToken(): string {
  const authorization = [...upstreamCalls].reverse().find(call => (
    call.url.pathname.startsWith('/api/__internal/public-mcp/v1/')
    && !call.url.pathname.includes('/token')
    && call.url.pathname !== '/api/__internal/public-mcp/v1/approvals/consume'
    && call.authorization.startsWith('Bearer ')
  ))?.authorization;
  assert.ok(authorization);
  return authorization.slice('Bearer '.length);
}

function assertNoRawPlatformTokens(payload: unknown): void {
  const serialized = JSON.stringify(payload);
  for (const rawToken of allRawPlatformTokens) {
    assert.equal(
      serialized.includes(rawToken),
      false,
      'raw platform access and refresh tokens must never appear in public OAuth responses',
    );
  }
}

function issueBuilderToken(projectScope: string): string {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify({
    userId: 'builder-user-1',
    projectScope,
    iss: 'Spala-Builder',
    aud: 'builder-ui',
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })).toString('base64url');
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', builderJwtSecret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

function builderAuthorizationHasScope(authorization: string, projectScope: string): boolean {
  if (!authorization.startsWith('Bearer ')) return false;
  try {
    const token = authorization.slice('Bearer '.length);
    const [encodedHeader, encodedPayload, signature, extra] = token.split('.');
    if (!encodedHeader || !encodedPayload || !signature || extra) return false;
    const unsigned = `${encodedHeader}.${encodedPayload}`;
    const expected = createHmac('sha256', builderJwtSecret).update(unsigned).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Record<string, unknown>;
    return header['alg'] === 'HS256'
      && payload['iss'] === 'Spala-Builder'
      && payload['aud'] === 'builder-ui'
      && typeof payload['exp'] === 'number'
      && payload['exp'] > Math.floor(Date.now() / 1_000)
      && payload['projectScope'] === projectScope;
  } catch {
    return false;
  }
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  const headers = new Headers(init?.headers);
  const authorization = headers.get('authorization') || '';
  const serviceAuthentication = headers.get('x-spala-public-mcp-service-secret') || '';
  if (
    url.origin !== 'https://api.spala.ai'
    && url.origin !== projectUrl
    && url.origin !== sharedRuntimeOrigin
  ) {
    return nativeFetch(input, init);
  }
  upstreamCalls.push({
    url,
    method: init?.method || 'GET',
    authorization,
    serviceAuthentication,
    body: typeof init?.body === 'string' ? init.body : undefined,
  });
  if (url.origin === sharedRuntimeOrigin) {
    if (url.pathname === `/${sharedRuntimeSlug}/mcp/agent-instructions/mcp_agent_test/consume`) {
      if (init?.method !== 'POST') {
        return Response.json({ error: 'method_not_allowed' }, { status: 405 });
      }
      if (authorization) {
        return Response.json({ error: 'authorization_must_be_absent' }, { status: 400 });
      }
      bootstrapConsumeCount += 1;
      if (bootstrapConsumeCount > 1) {
        return Response.json({ error: 'bootstrap_already_consumed' }, { status: 410 });
      }
      return Response.json({
        access_token: installerProjectAccessToken,
        token_type: 'Bearer',
        expires_at: installerProjectAccessExpiresAt,
        scopes: authorizedProjectScope.split(','),
        mcp_url: canonicalProjectMcpUrl,
      }, {
        headers: {
          'cache-control': 'no-store, no-cache, private',
          pragma: 'no-cache',
        },
      });
    }
    if (
      url.pathname === `/${sharedRuntimeSlug}/api/__internal/builder-auth/external`
      && init?.method === 'POST'
    ) {
      if (authorization) return Response.json({ error: 'authorization_must_be_absent' }, { status: 400 });
      if (String(init.body) !== JSON.stringify({ token: temporaryProjectToken })) {
        return Response.json({ error: 'invalid_exchange_body' }, { status: 400 });
      }
      return Response.json({ token: runtimeBuilderProjectToken });
    }
    if (
      url.pathname === `/${sharedRuntimeSlug}/mcp/agent-instructions`
      && init?.method === 'POST'
    ) {
      if (!builderAuthorizationHasScope(authorization, 'project-1')) {
        return Response.json({ error: 'invalid_project_token' }, { status: 401 });
      }
      const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
      if (
        body['scope'] !== authorizedProjectScope
        || body['deliveryMode'] !== 'one-time'
      ) {
        return Response.json({ error: 'bootstrap_binding_mismatch' }, { status: 400 });
      }
      return Response.json({
        consumeUrl: bootstrapConsumeUrl,
        scopes: authorizedProjectScope.split(','),
        deliveryMode: 'one-time',
      }, { status: 201 });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  if (url.origin === projectUrl) {
    if (url.pathname === '/api/__internal/builder-auth/external' && init?.method === 'POST') {
      if (authorization) return Response.json({ error: 'authorization_must_be_absent' }, { status: 400 });
      if (String(init.body) !== JSON.stringify({ token: temporaryProjectToken })) {
        return Response.json({ error: 'invalid_exchange_body' }, { status: 400 });
      }
      return Response.json({ token: builderProjectToken });
    }
    if (!builderAuthorizationHasScope(authorization, 'root')) {
      return Response.json({ error: 'invalid_project_token' }, { status: 401 });
    }
    if (url.pathname === '/api/__internal/project/config' && init?.method === 'POST') {
      if (projectConfigFailures.has(builderProjectToken)) {
        return Response.json({ error: { code: 'forbidden', message: `${builderProjectToken} must not escape` } }, { status: 403 });
      }
      return Response.json({ success: true });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  if (networkFailurePlatformRoutes.has(url.pathname)) throw new TypeError('upstream network failure');
  if (transientPlatformRoutes.has(url.pathname)) {
    return Response.json({ error: 'upstream_unavailable' }, { status: 503 });
  }

  if (url.pathname === '/api/public-mcp/v1/approvals' && init?.method === 'POST') {
    const dashboardToken = authorization.replace(/^Bearer /, '');
    const account = dashboardAccounts.get(dashboardToken);
    if (!account) return Response.json({ error: 'invalid_token' }, { status: 401 });
    const body = JSON.parse(String(init.body)) as { request?: unknown };
    if (typeof body.request !== 'string') return Response.json({ error: 'invalid_request' }, { status: 400 });
    const approvalProof = `opaque-approval-proof-${credentialSequence += 1}`;
    approvalProofs.set(approvalProof, { request: body.request, account });
    return Response.json({ approvalProof }, { status: 201 });
  }

  const lifecycleRoutes = new Set([
    '/api/__internal/public-mcp/v1/approvals/consume',
    '/api/__internal/public-mcp/v1/token',
    '/api/__internal/public-mcp/v1/token/refresh',
    '/api/__internal/public-mcp/v1/token/revoke',
  ]);
  if (lifecycleRoutes.has(url.pathname)) {
    if (serviceAuthentication !== platformServiceSecret || authorization) {
      return Response.json({ error: 'invalid_service_auth' }, { status: 401 });
    }
    const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
    if (url.pathname === '/api/__internal/public-mcp/v1/approvals/consume') {
      const approvalProof = body['approvalProof'];
      const requestHash = body['requestHash'];
      const clientHash = body['clientHash'];
      const approval = typeof approvalProof === 'string' ? approvalProofs.get(approvalProof) : undefined;
      if (
        !approval
        || requestHash !== createHash('sha256').update(approval.request).digest('hex')
        || typeof clientHash !== 'string'
        || !/^[a-f0-9]{64}$/.test(clientHash)
        || body['resource'] !== 'https://mcp.spala.ai/mcp'
        || body['scope'] !== 'api'
        || (approval.clientHash !== undefined && approval.clientHash !== clientHash)
      ) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      const grantCode = approval.grantCode || `opaque-platform-grant-${credentialSequence += 1}`;
      approval.clientHash = clientHash;
      approval.grantCode = grantCode;
      platformGrants.set(grantCode, { account: approval.account, clientHash });
      if (ambiguousPlatformRoutes.delete(url.pathname)) {
        return Response.json({ error: 'upstream_unavailable' }, { status: 503 });
      }
      return Response.json({ grantCode, expiresIn: 300 });
    }
    if (url.pathname === '/api/__internal/public-mcp/v1/token') {
      const grantCode = body['grantCode'];
      const clientHash = body['clientHash'];
      const grant = typeof grantCode === 'string' ? platformGrants.get(grantCode) : undefined;
      if (
        !grant
        || clientHash !== grant.clientHash
        || body['resource'] !== 'https://mcp.spala.ai/mcp'
        || body['scope'] !== 'api'
      ) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      if (tokenIssueGate) {
        const gate = tokenIssueGate;
        gate.started.resolve();
        await gate.release.promise;
      }
      if (ambiguousPlatformRoutes.delete(url.pathname)) {
        return Response.json({ error: 'upstream_unavailable' }, { status: 503 });
      }
      if (usedPlatformGrants.has(grantCode as string)) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      usedPlatformGrants.add(grantCode as string);
      const tokens = issuePlatformCredentials(grant.account, grant.clientHash);
      return Response.json(tokens);
    }
    if (url.pathname === '/api/__internal/public-mcp/v1/token/refresh') {
      const refreshToken = body['refreshToken'];
      const clientHash = body['clientHash'];
      const retry = typeof refreshToken === 'string' ? refreshRetryCredentials.get(refreshToken) : undefined;
      const credential = typeof refreshToken === 'string'
        ? refreshCredentials.get(refreshToken) || retry?.credential
        : undefined;
      if (
        !credential
        || clientHash !== credential.clientHash
        || body['resource'] !== 'https://mcp.spala.ai/mcp'
        || body['scope'] !== 'api'
      ) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      if (retry) {
        if (retry.retries >= 1) {
          revokeCredentialFamily(credential.familyId);
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        retry.retries += 1;
        return Response.json({
          ...retry.tokens,
          expires_in: Math.max(
            1,
            Math.floor(
              (Date.parse(retry.tokens.access_expires_at) - Date.now() - platformClockOffsetMs) / 1_000,
            ),
          ),
        });
      }
      refreshCredentials.delete(refreshToken as string);
      revokeCredentialFamily(credential.familyId);
      const tokens = issuePlatformCredentials(
        credential.account,
        credential.clientHash,
        credential.familyId,
      );
      refreshRetryCredentials.set(refreshToken as string, { credential, tokens, retries: 0 });
      if (ambiguousPlatformRoutes.delete(url.pathname)) {
        return Response.json({ error: 'upstream_unavailable' }, { status: 503 });
      }
      return Response.json(tokens);
    }
    if (url.pathname === '/api/__internal/public-mcp/v1/token/revoke') {
      const token = body['token'];
      const clientHash = body['clientHash'];
      if (
        typeof token !== 'string'
        || typeof clientHash !== 'string'
        || body['resource'] !== 'https://mcp.spala.ai/mcp'
      ) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      const credential = accessCredentials.get(token) || refreshCredentials.get(token);
      if (credential?.clientHash === clientHash) {
        revokeCredentialFamily(credential.familyId);
      }
      revokedAccessTokens.add(token);
      return new Response(null, { status: 200 });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  if (
    url.pathname.startsWith('/api/__internal/public-mcp/v1/')
    && serviceAuthentication !== platformServiceSecret
  ) {
    return Response.json({ error: 'invalid_service_auth' }, { status: 401 });
  }
  const accessToken = authorization.replace(/^Bearer /, '');
  const credential = accessCredentials.get(accessToken);
  const account = credential?.account;
  if (!credential || revokedAccessTokens.has(accessToken)) {
    return Response.json({ error: 'invalid_token' }, { status: 401 });
  }
  if (insufficientScopeAccessTokens.has(accessToken)) {
    return Response.json({ error: 'insufficient_scope' }, { status: 403 });
  }
  if (disabledPrincipalAccessTokens.has(accessToken)) {
    return Response.json({ error: 'access_denied' }, { status: 403 });
  }
  if (url.pathname === '/api/__internal/public-mcp/v1/principal') {
    if (account === 'new') {
      return Response.json({
        user: {
          id: 'user-new',
          email: 'new@example.test',
          ...(newAccountProfile ? { first_name: newAccountProfile.firstName, last_name: newAccountProfile.lastName } : {}),
        },
        organizations: newAccountOrganization ? [newAccountOrganization] : [],
      });
    }
    return Response.json({
      user: { id: 'user-1', email: 'user@example.test', first_name: 'Test', last_name: 'User' },
      organizations: [{ id: 'org-1', name: 'First organization' }],
    });
  }
  if (account === 'new' && url.pathname === '/api/__internal/public-mcp/v1/users' && init?.method === 'PATCH') {
    const body = JSON.parse(String(init.body)) as { first_name: string; last_name: string };
    newAccountProfile = { firstName: body.first_name, lastName: body.last_name };
    return Response.json({});
  }
  if (account === 'new' && url.pathname === '/api/__internal/public-mcp/v1/organizations' && init?.method === 'POST') {
    const body = JSON.parse(String(init.body)) as { name: string };
    newAccountOrganization = { id: 'org-new', name: body.name };
    return Response.json({ organization: { organization_id: 'org-new', name: body.name } }, { status: 201 });
  }
  if (url.pathname === '/api/__internal/public-mcp/v1/projects' && init?.method === 'GET') {
    return Response.json({ projects: [{ id: 'project-1', project_name: 'Project One', status: 'ready', subdomain: 'project-one.example' }] });
  }
  if (url.pathname === '/api/__internal/public-mcp/v1/projects' && init?.method === 'POST') {
    if (account === 'plan') {
      return Response.json({ error: { code: 'plan_restricted', message: 'private billing detail' } }, { status: 403 });
    }
    return Response.json({ id: 'project-created', project_name: 'Created Project', status: 'creating', subdomain: 'project-created' }, { status: 201 });
  }
  if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') {
    return Response.json({
      projectId: 'project-1',
      projectName: 'Project One',
      status: 'ready',
      projectUrl,
      mcpEnabled: true,
      mcpUrl: canonicalProjectMcpUrl,
      manifestUrl: canonicalProjectManifestUrl,
    });
  }
  if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1' && init?.method === 'GET') {
    return Response.json({ id: 'project-1', project_name: 'Project One', status: 'ready', subdomain: 'project-one.example' });
  }
  if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url' && init?.method === 'GET') {
    if (runtimeRevokedAccessTokens.has(accessToken)) {
      return Response.json({ error: 'invalid_token' }, { status: 401 });
    }
    const encodedProjectUrl = Buffer.from(projectUrl).toString('base64');
    return Response.json({
      url: `https://app.spala.ai/?url=${encodeURIComponent(encodedProjectUrl)}&auth_token=${temporaryProjectToken}`,
    });
  }
  return Response.json({ error: 'not_found' }, { status: 404 });
}) as typeof fetch;

process.env['PUBLIC_BASE_URL'] = 'https://mcp.spala.ai';
process.env['SPALA_API_BASE_URL'] = 'https://api.spala.ai';
process.env['PUBLIC_OAUTH_ENCRYPTION_SECRET'] = 'server-test-public-oauth-encryption-secret-32-bytes';
process.env['PUBLIC_MCP_PLATFORM_SERVICE_SECRET'] = platformServiceSecret;
process.env['PUBLIC_MCP_TRUSTED_SHARED_RUNTIME_ORIGINS'] = sharedRuntimeOrigin;
process.env['PUBLIC_OAUTH_REPLAY_STATE_PATH'] = replayStatePath;
process.env['SPALA_DASHBOARD_URL'] = 'https://dashboard.spala.ai';
process.env['SPALA_PRICING_URL'] = 'https://spala.ai/pricing/';
process.env['SPALA_DOCS_URL'] = 'https://docs.spala.ai/agents/mcp';
process.env['CORS_ALLOWED_ORIGINS'] = 'https://client.example';
process.env['MCP_RATE_LIMIT_MAX'] = '1000';
process.env['PUBLIC_OAUTH_RATE_LIMIT_MAX'] = '1000';

const { app } = await import('../src/server.js');
const server = http.createServer(app);
let baseUrl = '';

before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  globalThis.fetch = nativeFetch;
  rmSync(replayStatePath, { recursive: true, force: true });
});

function challenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = body.split('\n').find(line => line.startsWith('data: '))?.slice(6);
    if (!data) throw new Error(`Missing SSE data: ${body}`);
    return JSON.parse(data) as Record<string, unknown>;
  }
  return JSON.parse(body) as Record<string, unknown>;
}

async function mcpRequest(name: string, arguments_: unknown, authorization?: string): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ } }),
  });
}

async function mcpRpc(method: string, params: Record<string, unknown>, authorization?: string): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function toolBody(response: Response): Promise<Record<string, unknown>> {
  const envelope = await responseJson(response);
  const result = envelope.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

async function beginAuthorization() {
  const registrationResponse = await fetch(`${baseUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:3939/callback'] }),
  });
  assert.equal(registrationResponse.status, 201);
  const registration = await responseJson(registrationResponse);
  const clientId = registration.client_id as string;
  const verifier = 'v'.repeat(64);
  const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', 'http://127.0.0.1:3939/callback');
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('resource', 'https://mcp.spala.ai/mcp');
  authorizeUrl.searchParams.set('scope', 'api');
  authorizeUrl.searchParams.set('state', 'client-state');
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('code_challenge', challenge(verifier));
  const authorizationResponse = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(authorizationResponse.status, 302);
  const dashboardUrl = new URL(authorizationResponse.headers.get('location')!);
  assert.equal(dashboardUrl.origin, 'https://dashboard.spala.ai');
  assert.equal(dashboardUrl.pathname, '/mcp/authorize');
  const request = dashboardUrl.searchParams.get('request');
  assert.ok(request);
  return { clientId, verifier, request };
}

async function createApprovalProof(request: string, dashboardToken = 'dashboard-valid'): Promise<string> {
  const response = await fetch('https://api.spala.ai/api/public-mcp/v1/approvals', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${dashboardToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ request }),
  });
  assert.equal(response.status, 201);
  const approvalProof = (await responseJson(response)).approvalProof;
  assert.equal(typeof approvalProof, 'string');
  return approvalProof as string;
}

async function authorize(dashboardToken = 'dashboard-valid') {
  const { clientId, verifier, request } = await beginAuthorization();
  const approvalProof = await createApprovalProof(request, dashboardToken);
  const approval = await fetch(`${baseUrl}/oauth/dashboard/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request, approvalProof }),
  });
  assert.equal(approval.status, 200);
  assert.equal(approval.headers.get('cache-control'), 'no-store');
  const callback = new URL((await responseJson(approval)).redirectTo as string);
  assert.equal(callback.origin, 'http://127.0.0.1:3939');
  assert.equal(callback.pathname, '/callback');
  assert.equal(callback.searchParams.get('state'), 'client-state');
  const code = callback.searchParams.get('code');
  assert.ok(code);
  return { clientId, verifier, code };
}

async function redeem(
  clientId: string,
  code: string,
  verifier: string,
  redirectUri: string | null = 'http://127.0.0.1:3939/callback',
): Promise<Response> {
  return fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      ...(redirectUri === null ? {} : { redirect_uri: redirectUri }),
      resource: 'https://mcp.spala.ai/mcp',
      code,
      code_verifier: verifier,
    }),
  });
}

async function refresh(clientId: string, refreshToken: string, resource?: string): Promise<Response> {
  return fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
      ...(resource ? { resource } : {}),
    }),
  });
}

async function revoke(clientId: string, token: string, tokenTypeHint?: string): Promise<Response> {
  return fetch(`${baseUrl}/oauth/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      token,
      ...(tokenTypeHint ? { token_type_hint: tokenTypeHint } : {}),
    }),
  });
}

test('OAuth metadata advertises public endpoints and no device flow', async () => {
  const response = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
  assert.equal(response.status, 200);
  const metadata = await responseJson(response);
  assert.deepEqual(metadata, {
    issuer: 'https://mcp.spala.ai',
    authorization_endpoint: 'https://mcp.spala.ai/oauth/authorize',
    token_endpoint: 'https://mcp.spala.ai/oauth/token',
    revocation_endpoint: 'https://mcp.spala.ai/oauth/revoke',
    registration_endpoint: 'https://mcp.spala.ai/oauth/register',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['api'],
  });
  assert.deepEqual(
    await responseJson(await fetch(`${baseUrl}/.well-known/oauth-authorization-server/mcp`)),
    metadata,
    'the suffixed route is a compatibility alias only',
  );
});

test('dashboard approval CORS permits the dashboard origin and rejects unconfigured origins', async () => {
  const dashboard = await fetch(`${baseUrl}/oauth/dashboard/approve`, {
    method: 'OPTIONS',
    headers: { origin: 'https://dashboard.spala.ai' },
  });
  assert.equal(dashboard.status, 204);
  assert.equal(dashboard.headers.get('access-control-allow-origin'), 'https://dashboard.spala.ai');
  assert.match(dashboard.headers.get('access-control-allow-headers') || '', /Authorization/);

  const rejected = await fetch(`${baseUrl}/oauth/dashboard/approve`, { headers: { origin: 'https://evil.example' } });
  assert.equal(rejected.status, 403);
});

test('authorize, dashboard approval, token redemption, and project list work end to end', async () => {
  const { clientId, verifier, code } = await authorize();
  const tokenResponse = await redeem(clientId, code, verifier);
  assert.equal(tokenResponse.status, 200);
  const token = await responseJson(tokenResponse);
  const accessToken = token.access_token as string;
  const refreshToken = token.refresh_token as string;
  assert.match(accessToken, /^v1a\./);
  assert.match(refreshToken, /^v1r\./);
  assert.equal(accessCredentials.has(accessToken), false, 'raw platform access must not leave /oauth/token');
  assert.equal(refreshCredentials.has(refreshToken), false, 'raw platform refresh must not leave /oauth/token');
  assertNoRawPlatformTokens(token);
  assert.equal(token.scope, 'api');
  assert.equal(token.resource, 'https://mcp.spala.ai/mcp');
  assert.doesNotMatch(JSON.stringify(token), /dashboard-valid|api\.spala\.ai/);

  const listed = await mcpRequest('project_list', { organizationId: 'org-1' }, `Bearer ${accessToken}`);
  assert.equal(listed.status, 200);
  const delegatedAccess = latestDelegatedAccessToken();
  assert.notEqual(delegatedAccess, accessToken);
  assert.equal(accessCredentials.has(delegatedAccess), true);
  assert.deepEqual(await toolBody(listed), {
    organization: { id: 'org-1', name: 'First organization' },
    projects: [{ id: 'project-1', name: 'Project One', status: 'ready', subdomain: 'project-one.example', organizationId: 'org-1' }],
  });
  assert.ok(upstreamCalls.some(call => call.url.pathname === '/api/__internal/public-mcp/v1/principal' && call.authorization === `Bearer ${delegatedAccess}`));
  assert.ok(upstreamCalls.some(call => call.url.pathname === '/api/__internal/public-mcp/v1/projects' && call.authorization === `Bearer ${delegatedAccess}`));
  const operationCalls = upstreamCalls.filter(call => (
    call.url.pathname.startsWith('/api/__internal/public-mcp/v1/')
    && !call.url.pathname.includes('/token')
    && call.url.pathname !== '/api/__internal/public-mcp/v1/approvals/consume'
  ));
  assert.ok(operationCalls.length > 0);
  assert.ok(operationCalls.every(call => call.serviceAuthentication === platformServiceSecret));
  assert.ok(operationCalls.every(call => call.authorization === `Bearer ${delegatedAccess}`));
  assert.ok(operationCalls.every(call => call.authorization !== 'Bearer dashboard-valid'));
  const lifecycleCalls = upstreamCalls.filter(call => (
    call.url.pathname === '/api/__internal/public-mcp/v1/approvals/consume'
    || call.url.pathname === '/api/__internal/public-mcp/v1/token'
  ));
  assert.ok(lifecycleCalls.length >= 2);
  assert.ok(lifecycleCalls.every(call => (
    call.serviceAuthentication === platformServiceSecret && call.authorization === ''
  )));
  assert.equal(upstreamCalls.some(call => [
    '/api/me',
    '/api/users',
    '/api/organizations',
    '/api/projects',
  ].includes(call.url.pathname)), false);
});

test('account status, project preparation, workspace binding, and revoked-session reauthentication work end to end', async () => {
  const authorization = await authorize();
  const token = await responseJson(await redeem(authorization.clientId, authorization.code, authorization.verifier));
  const accessToken = token.access_token as string;
  const bearer = `Bearer ${accessToken}`;

  const status = await mcpRequest('account_status', {}, bearer);
  assert.equal(status.status, 200);
  assert.deepEqual(await toolBody(status), {
    authenticated: true,
    tokenStatus: 'active',
    subject: 'user-1',
    user: { id: 'user-1', email: 'user@example.test', firstName: 'Test', lastName: 'User' },
    organizations: [{ id: 'org-1', name: 'First organization' }],
    accountSetup: { state: 'ready', missingFields: [] },
    next: 'Ask for or confidently derive a real project name, then reuse .spala/project.json or call project_list before project_create.',
  });

  const callsBeforeConnect = upstreamCalls.length;
  const connected = await mcpRequest('project_connect', { projectId: 'project-1', client: 'codex' }, bearer);
  assert.equal(connected.status, 200);
  const connectedBody = await toolBody(connected);
  const delegatedAccessToken = latestDelegatedAccessToken();
  assert.equal(connectedBody.mcpUrl, canonicalProjectMcpUrl);
  assert.equal((connectedBody.handoff as Record<string, unknown>).mcpUrl, canonicalProjectMcpUrl);
  assert.equal(connectedBody.workspaceOnly, true);
  assert.equal(connectedBody.preparedByProjectBackend, true);
  assert.equal(connectedBody.bootstrapPreparedByProjectBackend, true);
  const plan = connectedBody.installPlan as {
    argv: string[];
    globalInstall: boolean;
    workspaceScope: string;
    execution: {
      shell: boolean;
      tty: boolean;
      waitForRunningProcess: boolean;
      stdin: Record<string, unknown>;
    };
  };
  assert.deepEqual(plan.argv.slice(0, 5), ['npx', '--yes', '@spala-ai/mcp-install@0.1.16', 'project', 'bind']);
  assert.equal((connectedBody.installPlan as Record<string, unknown>).mcpUrl, canonicalProjectMcpUrl);
  assert.equal(plan.argv[plan.argv.indexOf('--project-id') + 1], 'project-1');
  assert.equal(plan.argv[plan.argv.indexOf('--project-url') + 1], projectUrl);
  assert.equal(plan.argv[plan.argv.indexOf('--url') + 1], connectedBody.mcpUrl);
  assert.equal(plan.argv[plan.argv.indexOf('--name') + 1], connectedBody.serverName);
  assert.equal(plan.argv[plan.argv.indexOf('--client') + 1], 'codex');
  assert.equal(plan.argv[plan.argv.indexOf('--install-scope') + 1], 'workspace');
  assert.equal(plan.argv.includes('--bootstrap-stdin'), true);
  assert.equal(plan.argv.includes('--bootstrap-url'), false);
  assert.equal(plan.argv.includes(bootstrapConsumeUrl), false);
  assert.equal((connectedBody.bootstrap as Record<string, unknown>).consumeUrl, bootstrapConsumeUrl);
  assert.equal(plan.globalInstall, false);
  assert.equal(plan.workspaceScope, 'workspace');
  assert.equal(plan.execution.shell, false);
  assert.equal(plan.execution.tty, true);
  assert.equal(plan.execution.waitForRunningProcess, true);
  assert.deepEqual(plan.execution.stdin, {
    tool: 'process_stdin',
    processSource: 'running_process',
    valueSource: 'bootstrap.consumeUrl',
    appendNewline: true,
    shell: false,
    argv: false,
  });
  assert.ok(upstreamCalls.some(call => (
    call.url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url'
    && call.method === 'GET'
    && call.authorization === `Bearer ${delegatedAccessToken}`
  )));
  assert.equal(upstreamCalls.some(call => call.url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp/prepare'), false);
  const connectionUpstreamCalls = upstreamCalls.slice(callsBeforeConnect);
  assert.deepEqual(
    connectionUpstreamCalls.filter(call => call.url.origin === projectUrl).map(call => `${call.method} ${call.url.pathname}`),
    ['POST /api/__internal/builder-auth/external', 'POST /api/__internal/project/config'],
  );
  assert.deepEqual(
    connectionUpstreamCalls.filter(call => call.url.origin === sharedRuntimeOrigin).map(call => `${call.method} ${call.url.pathname}`),
    [
      `POST /${sharedRuntimeSlug}/api/__internal/builder-auth/external`,
      `POST /${sharedRuntimeSlug}/mcp/agent-instructions`,
    ],
  );
  assert.deepEqual(
    connectionUpstreamCalls
      .filter(call => (
        call.url.origin === projectUrl
        || call.url.origin === sharedRuntimeOrigin
        || call.url.pathname.endsWith('/mcp-handoff')
        || call.url.pathname.endsWith('/access-url')
      ))
      .map(call => `${call.method} ${call.url.origin}${call.url.pathname}`),
    [
      'GET https://api.spala.ai/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff',
      'GET https://api.spala.ai/api/__internal/public-mcp/v1/projects/project-1/access-url',
      'POST https://project-one.example/api/__internal/builder-auth/external',
      'POST https://project-one.example/api/__internal/project/config',
      'GET https://api.spala.ai/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff',
      `POST ${sharedRuntimeOrigin}/${sharedRuntimeSlug}/api/__internal/builder-auth/external`,
      `POST ${sharedRuntimeOrigin}/${sharedRuntimeSlug}/mcp/agent-instructions`,
    ],
  );
  const projectUpstreamCalls = connectionUpstreamCalls.filter(call => call.url.origin === projectUrl);
  const sharedRuntimeCalls = connectionUpstreamCalls.filter(call => call.url.origin === sharedRuntimeOrigin);
  assert.ok(projectUpstreamCalls.every(call => call.serviceAuthentication === ''));
  assert.ok(sharedRuntimeCalls.every(call => call.serviceAuthentication === ''));
  assert.equal(projectUpstreamCalls[0]?.authorization, '');
  assert.equal(projectUpstreamCalls[0]?.body, JSON.stringify({ token: temporaryProjectToken }));
  assert.ok(projectUpstreamCalls.slice(1).every(call => call.authorization === `Bearer ${builderProjectToken}`));
  assert.equal(sharedRuntimeCalls[0]?.authorization, '');
  assert.equal(sharedRuntimeCalls[0]?.body, JSON.stringify({ token: temporaryProjectToken }));
  assert.equal(sharedRuntimeCalls[1]?.authorization, `Bearer ${runtimeBuilderProjectToken}`);
  assert.equal(sharedRuntimeCalls[1]?.body, JSON.stringify({
    scope: authorizedProjectScope,
    clientName: 'Spala codex agent',
    deliveryMode: 'one-time',
  }));
  assert.equal((connectedBody.handoff as Record<string, unknown>).bootstrapConsumeUrl, undefined);
  assert.equal(JSON.stringify(connectedBody).split('mcp_agent_test').length - 1, 1);
  assert.doesNotMatch(
    JSON.stringify(connectedBody),
    new RegExp([
      'dashboard-valid',
      'project-entry-token',
      builderProjectToken,
      runtimeBuilderProjectToken,
      installerProjectAccessToken,
      platformServiceSecret,
      accessToken,
      'api\\.spala\\.ai',
    ].join('|')),
  );

  const entryTokenAtSharedMount = await fetch(
    `${sharedRuntimeOrigin}/${sharedRuntimeSlug}/mcp/agent-instructions`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${builderProjectToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        scope: authorizedProjectScope,
        clientName: 'Spala codex agent',
        deliveryMode: 'one-time',
      }),
    },
  );
  assert.equal(entryTokenAtSharedMount.status, 401, 'the projectUrl builder token must not authenticate at the shared mount');

  bootstrapConsumeCount = 0;
  const wrongMethod = await fetch(bootstrapConsumeUrl);
  assert.equal(wrongMethod.status, 405, 'installer 0.1.16 must consume the capability with POST');
  assert.equal(bootstrapConsumeCount, 0, 'a wrong-method request must not consume the capability');

  const installerResponse = await fetch(bootstrapConsumeUrl, {
    method: 'POST',
    headers: { accept: 'application/json' },
  });
  assert.equal(installerResponse.status, 200);
  assert.match(installerResponse.headers.get('cache-control') || '', /no-store/);
  assert.equal(installerResponse.headers.get('pragma'), 'no-cache');
  const installerBootstrap = await responseJson(installerResponse);
  assert.deepEqual(installerBootstrap, {
    access_token: installerProjectAccessToken,
    token_type: 'Bearer',
    expires_at: installerProjectAccessExpiresAt,
    scopes: authorizedProjectScope.split(','),
    mcp_url: canonicalProjectMcpUrl,
  });
  assert.equal(installerBootstrap.mcp_url, connectedBody.mcpUrl);
  assert.equal(installerBootstrap.mcp_url, (connectedBody.handoff as Record<string, unknown>).mcpUrl);
  assert.equal(installerBootstrap.mcp_url, (connectedBody.installPlan as Record<string, unknown>).mcpUrl);
  assert.equal(
    installerBootstrap.mcp_url,
    plan.argv[plan.argv.indexOf('--url') + 1],
    'the consumed bootstrap and installer argv must bind the same scoped endpoint',
  );
  assert.doesNotMatch(JSON.stringify(connectedBody), new RegExp(installerProjectAccessToken));
  assert.equal(plan.argv.includes(installerProjectAccessToken), false);
  const consumedAgain = await fetch(bootstrapConsumeUrl, { method: 'POST' });
  assert.equal(consumedAgain.status, 410, 'the installer capability must remain one-time');

  const callsBeforeConfigFailure = upstreamCalls.length;
  projectConfigFailures.add(builderProjectToken);
  try {
    const configFailure = await mcpRequest('project_connect', { projectId: 'project-1', client: 'codex' }, bearer);
    assert.equal(configFailure.status, 200);
    const failureBody = await toolBody(configFailure);
    assert.equal(failureBody.category, 'forbidden');
    assert.equal(JSON.stringify(failureBody).includes(temporaryProjectToken), false);
    assert.equal(JSON.stringify(failureBody).includes(builderProjectToken), false);
    assert.equal(JSON.stringify(failureBody).includes(runtimeBuilderProjectToken), false);
    assert.doesNotMatch(JSON.stringify(failureBody), /api\.spala\.ai/);
    assert.deepEqual(upstreamCalls.slice(callsBeforeConfigFailure)
      .filter(call => call.url.origin === projectUrl)
      .map(call => `${call.method} ${call.url.pathname}`), [
        'POST /api/__internal/builder-auth/external',
        'POST /api/__internal/project/config',
      ]);
  } finally {
    projectConfigFailures.delete(builderProjectToken);
  }

  runtimeRevokedAccessTokens.add(delegatedAccessToken);
  try {
    const revokedDuringPrepare = await mcpRequest('project_connect', { projectId: 'project-1', client: 'codex' }, bearer);
    assert.equal(revokedDuringPrepare.status, 200);
    const revokedBody = await toolBody(revokedDuringPrepare);
    assert.equal(revokedBody.error, 'reauthentication_required');
    assert.equal(revokedBody.category, 'authentication');
    assert.match(String(revokedBody.message), /expired or was revoked/i);
    assert.deepEqual(revokedBody.action, {
      type: 'reauthenticate_public_mcp',
      authorizationEndpoint: 'https://mcp.spala.ai/oauth/authorize',
      requiredScope: 'api',
    });
    assert.doesNotMatch(JSON.stringify(revokedBody), /upstream_unavailable|service unavailable|api\.spala\.ai/i);
  } finally {
    runtimeRevokedAccessTokens.delete(delegatedAccessToken);
  }

  revokedAccessTokens.add(delegatedAccessToken);
  try {
    const revoked = await mcpRequest('account_status', {}, bearer);
    assert.equal(revoked.status, 401);
    assert.match(revoked.headers.get('www-authenticate') || '', /^Bearer /);
    const revokedBody = await responseJson(revoked);
    assert.match(String((revokedBody.error as { message?: string }).message), /expired or was revoked/i);
    assert.doesNotMatch(JSON.stringify(revokedBody), /upstream_unavailable|service unavailable/i);
  } finally {
    revokedAccessTokens.delete(delegatedAccessToken);
  }
});

test('generated project bind plan and bootstrap run against the local installer contract', {
  skip: !localInstallerRoot,
}, async () => {
  const installerCliPath = join(localInstallerRoot!, 'src/cli.js');
  assert.equal(existsSync(installerCliPath), true, 'SPALA_MCP_INSTALLER_ROOT must contain src/cli.js');
  const installer = await import(pathToFileURL(installerCliPath).href) as {
    runCli(
      argv: string[],
      env: NodeJS.ProcessEnv,
      cwd: string,
      streams: {
        stdin: NodeJS.ReadableStream;
        stdout: { write(chunk: string): void };
        stderr: { write(chunk: string): void };
      },
      runtime: { fetch: typeof fetch },
    ): Promise<void>;
  };

  const authorization = await authorize();
  const token = await responseJson(await redeem(
    authorization.clientId,
    authorization.code,
    authorization.verifier,
  ));
  const connected = await mcpRequest(
    'project_connect',
    { projectId: 'project-1', client: 'codex' },
    `Bearer ${token.access_token as string}`,
  );
  assert.equal(connected.status, 200);
  const connectedBody = await toolBody(connected);
  const plan = connectedBody.installPlan as { argv: string[]; mcpUrl: string };
  const consumeUrl = (connectedBody.bootstrap as { consumeUrl: string }).consumeUrl;
  assert.deepEqual(plan.argv.slice(0, 3), [
    'npx',
    '--yes',
    '@spala-ai/mcp-install@0.1.16',
  ]);

  const workspace = mkdtempSync(join(tmpdir(), 'spala-public-mcp-installer-smoke-'));
  const credentialHome = mkdtempSync(join(tmpdir(), 'spala-public-mcp-credentials-smoke-'));
  let stdout = '';
  let stderr = '';
  try {
    mkdirSync(join(workspace, '.git'));
    mkdirSync(join(workspace, '.codex'), { recursive: true });
    writeFileSync(join(workspace, '.codex', 'config.toml'), '[projects]\ntrust_level = "trusted"\n');
    bootstrapConsumeCount = 0;

    await installer.runCli(
      plan.argv.slice(3),
      { ...process.env, SPALA_MCP_CREDENTIAL_HOME: credentialHome },
      workspace,
      {
        stdin: Readable.from([`${consumeUrl}\n`]),
        stdout: { write: chunk => { stdout += chunk; } },
        stderr: { write: chunk => { stderr += chunk; } },
      },
      { fetch: async (input, init) => fetch(input, init) },
    );

    const result = JSON.parse(stdout) as Record<string, unknown>;
    const binding = JSON.parse(
      readFileSync(join(workspace, '.spala', 'project.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(result['ok'], true);
    assert.equal(result['outcome'], 'bound');
    assert.equal(binding['projectId'], 'project-1');
    assert.equal(binding['projectUrl'], projectUrl);
    const installedMcpUrl = new URL(String(binding['mcpUrl']));
    const plannedMcpUrl = new URL(plan.mcpUrl);
    assert.equal(installedMcpUrl.origin, plannedMcpUrl.origin);
    assert.equal(installedMcpUrl.pathname, plannedMcpUrl.pathname.replace(/\/+$/, ''));
    assert.equal(installedMcpUrl.searchParams.get('scope'), plannedMcpUrl.searchParams.get('scope'));
    assert.equal(bootstrapConsumeCount, 1, 'the local installer must POST the capability exactly once');
    assert.equal(stderr, '');
    assert.doesNotMatch(
      `${stdout}\n${readFileSync(join(workspace, '.spala', 'project.json'), 'utf8')}`,
      /mcp_agent_test|installer-only-project-access-token/,
    );

    const consumedAgain = await fetch(consumeUrl, { method: 'POST' });
    assert.equal(consumedAgain.status, 410, 'the local installer must consume a one-time session');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(credentialHome, { recursive: true, force: true });
  }
});

test('new account setup collects profile and company before first named project creation', async () => {
  newAccountProfile = undefined;
  newAccountOrganization = undefined;
  const authorization = await authorize('dashboard-new');
  const token = await responseJson(await redeem(authorization.clientId, authorization.code, authorization.verifier));
  const bearer = `Bearer ${token.access_token as string}`;

  const initial = await toolBody(await mcpRequest('account_status', {}, bearer));
  const delegatedAccessToken = latestDelegatedAccessToken();
  assert.deepEqual(initial.accountSetup, {
    state: 'required',
    missingFields: ['firstName', 'lastName', 'companyName'],
    nextTool: 'account_setup',
  });
  assert.equal(initial.blocked, true);
  assert.deepEqual(initial.gate, {
    state: 'blocked',
    reason: 'account_setup_required',
    missingFields: ['firstName', 'lastName', 'companyName'],
    requiredNextAction: 'ask_human_then_call_account_setup',
    nextAssistantResponse: 'Ask one concise terminal question for exactly missingFields, then wait for the answer. Do not include implementation progress or offer to continue other work.',
    prohibitedUntilResolved: [
      'inspect application source',
      'plan application implementation',
      'generate a design concept',
      'scaffold or write frontend code',
      'create or mutate backend resources',
      'run application tests or visual QA',
    ],
  });
  assert.match(String(initial.next), /ask.*missing account fields.*wait/i);
  assert.match(JSON.stringify(initial.gate), /frontend|design|coding|QA/i);

  const setup = await toolBody(await mcpRequest('account_setup', {
    firstName: 'Ada',
    lastName: 'Lovelace',
    companyName: 'Analytical Apps',
  }, bearer));
  assert.equal(setup.accountSetup, 'complete');
  assert.equal(setup.profileUpdated, true);
  assert.equal(setup.organizationCreated, true);
  assert.deepEqual(setup.organization, { id: 'org-new', name: 'Analytical Apps' });

  const organizationCreates = upstreamCalls.filter(call => (
    call.authorization === `Bearer ${delegatedAccessToken}`
    && call.url.pathname === '/api/__internal/public-mcp/v1/organizations'
    && call.method === 'POST'
  )).length;
  const repeatedSetup = await toolBody(await mcpRequest('account_setup', {}, bearer));
  assert.equal(repeatedSetup.accountSetup, 'complete');
  assert.equal(repeatedSetup.profileUpdated, false);
  assert.equal(repeatedSetup.organizationCreated, false);
  assert.equal(upstreamCalls.filter(call => (
    call.authorization === `Bearer ${delegatedAccessToken}`
    && call.url.pathname === '/api/__internal/public-mcp/v1/organizations'
    && call.method === 'POST'
  )).length, organizationCreates, 'repeating setup must not create another organization');

  const created = await toolBody(await mcpRequest('project_create', {
    name: 'Task Management App',
    organizationId: 'org-new',
  }, bearer));
  assert.equal(created.created, true);
  assert.equal((created.organization as { id: string }).id, 'org-new');
  assert.ok(upstreamCalls.some(call => call.url.pathname === '/api/__internal/public-mcp/v1/users' && call.method === 'PATCH'));
  assert.ok(upstreamCalls.some(call => call.url.pathname === '/api/__internal/public-mcp/v1/organizations' && call.method === 'POST'));
});

test('authorization codes are single-use after issuance and authorization errors redirect only to trusted callbacks', async () => {
  const { clientId, verifier, code } = await authorize();
  const wrongPkce = await redeem(clientId, code, 'x'.repeat(64));
  assert.equal(wrongPkce.status, 400);
  assert.equal((await responseJson(wrongPkce)).error, 'invalid_grant');

  const otherClient = await beginAuthorization();
  const wrongClient = await redeem(otherClient.clientId, code, verifier);
  assert.equal(wrongClient.status, 400);
  assert.equal((await responseJson(wrongClient)).error, 'invalid_grant');

  const redeemed = await redeem(clientId, code, verifier);
  assert.equal(redeemed.status, 200);
  const issued = await responseJson(redeemed);
  assertNoRawPlatformTokens(issued);
  const retried = await redeem(clientId, code, verifier);
  assert.equal(retried.status, 400);
  const retryError = await responseJson(retried);
  assert.equal(retryError.error, 'invalid_grant');
  assert.match(String(retryError.error_description), /revoke.*reauthorize/i);

  const bearerApproval = await fetch(`${baseUrl}/oauth/dashboard/approve`, {
    method: 'POST',
    headers: { authorization: 'Bearer invalid-dashboard', 'content-type': 'application/json' },
    body: JSON.stringify({ request: 'not-a-ticket', approvalProof: 'opaque-invalid-proof-value' }),
    redirect: 'manual',
  });
  assert.equal(bearerApproval.status, 400);
  assert.equal((await responseJson(bearerApproval)).error, 'invalid_request');

  const pending = await beginAuthorization();
  const invalidProof = await fetch(`${baseUrl}/oauth/dashboard/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: pending.request, approvalProof: 'opaque-invalid-proof-value' }),
  });
  assert.equal(invalidProof.status, 400);
  assert.equal((await responseJson(invalidProof)).error, 'invalid_grant');

  const redirectAttempt = await fetch(`${baseUrl}/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=http%3A%2F%2F127.0.0.1%3A4444%2Fcallback&response_type=code&resource=https%3A%2F%2Fmcp.spala.ai%2Fmcp&scope=api&state=state&code_challenge_method=S256&code_challenge=${challenge(verifier)}`, { redirect: 'manual' });
  assert.equal(redirectAttempt.status, 400);
  assert.equal(redirectAttempt.headers.get('location'), null);

  const trustedErrorUrl = new URL(`${baseUrl}/oauth/authorize`);
  trustedErrorUrl.searchParams.set('client_id', clientId);
  trustedErrorUrl.searchParams.set('redirect_uri', 'http://127.0.0.1:3939/callback');
  trustedErrorUrl.searchParams.set('response_type', 'code');
  trustedErrorUrl.searchParams.set('resource', 'https://mcp.spala.ai/mcp');
  trustedErrorUrl.searchParams.set('scope', 'wrong');
  trustedErrorUrl.searchParams.set('state', 'preserved-state');
  trustedErrorUrl.searchParams.set('code_challenge_method', 'S256');
  trustedErrorUrl.searchParams.set('code_challenge', challenge(verifier));
  const trustedError = await fetch(trustedErrorUrl, { redirect: 'manual' });
  assert.equal(trustedError.status, 302);
  const trustedLocation = new URL(trustedError.headers.get('location')!);
  assert.equal(trustedLocation.origin, 'http://127.0.0.1:3939');
  assert.equal(trustedLocation.searchParams.get('error'), 'invalid_scope');
  assert.equal(trustedLocation.searchParams.get('state'), 'preserved-state');

  const invalidClientError = new URL(trustedErrorUrl);
  invalidClientError.searchParams.set('client_id', 'not-a-valid-client');
  const invalidClientResponse = await fetch(invalidClientError, { redirect: 'manual' });
  assert.equal(invalidClientResponse.status, 401);
  assert.equal(invalidClientResponse.headers.get('location'), null);
  assert.equal((await responseJson(invalidClientResponse)).error, 'invalid_client');

  const phishingRegistration = await fetch(`${baseUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://evil.example/callback'] }),
  });
  assert.equal(phishingRegistration.status, 400);
  assert.equal((await responseJson(phishingRegistration)).error, 'invalid_request');

  const hostedRegistration = await fetch(`${baseUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    }),
  });
  assert.equal(hostedRegistration.status, 201);
  assert.deepEqual((await responseJson(hostedRegistration)).redirect_uris, ['https://claude.ai/api/mcp/auth_callback']);

  for (const redirectUri of [
    'https://claude.com/api/mcp/auth_callback',
    'https://claude.ai/api/mcp/auth_callback/',
    'https://subdomain.claude.ai/api/mcp/auth_callback',
    'https://claude.ai/api/mcp/auth_callback?next=https://evil.example',
    'codex://attacker.example/callback',
    'claude://attacker.example/oauth/callback',
    'vscode://attacker.example/mcp/oauth/callback',
  ]) {
    const rejected = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirectUri] }),
    });
    assert.equal(rejected.status, 400, redirectUri);
  }
});

test('authorization code redemption allows an omitted redirect_uri but rejects a supplied mismatch', async () => {
  const omitted = await authorize();
  const omittedResponse = await redeem(omitted.clientId, omitted.code, omitted.verifier, null);
  assert.equal(omittedResponse.status, 200);
  assertNoRawPlatformTokens(await responseJson(omittedResponse));

  const mismatched = await authorize();
  const mismatchResponse = await redeem(
    mismatched.clientId,
    mismatched.code,
    mismatched.verifier,
    'http://127.0.0.1:4949/callback',
  );
  assert.equal(mismatchResponse.status, 400);
  assert.equal((await responseJson(mismatchResponse)).error, 'invalid_grant');

  const recovered = await redeem(mismatched.clientId, mismatched.code, mismatched.verifier);
  assert.equal(recovered.status, 200);
  assertNoRawPlatformTokens(await responseJson(recovered));
});

test('concurrent authorization code redemption has one owner and never revokes the winner', async () => {
  const authorization = await authorize();
  const issuePath = '/api/__internal/public-mcp/v1/token';
  const revokePath = '/api/__internal/public-mcp/v1/token/revoke';
  const issueCallsBefore = upstreamCalls.filter(call => call.url.pathname === issuePath).length;
  const revokeCallsBefore = upstreamCalls.filter(call => call.url.pathname === revokePath).length;
  const gate = {
    started: deferred<void>(),
    release: deferred<void>(),
  };
  tokenIssueGate = gate;
  let winnerPromise: Promise<Response> | undefined;
  try {
    winnerPromise = redeem(authorization.clientId, authorization.code, authorization.verifier);
    await gate.started.promise;

    const loser = await redeem(authorization.clientId, authorization.code, authorization.verifier);
    assert.equal(loser.status, 503);
    assert.equal((await responseJson(loser)).error, 'temporarily_unavailable');
    assert.equal(
      upstreamCalls.filter(call => call.url.pathname === issuePath).length,
      issueCallsBefore + 1,
      'the losing request must not exchange the shared platform grant',
    );

    gate.release.resolve(undefined);
    const winner = await winnerPromise;
    assert.equal(winner.status, 200);
    const winnerTokens = await responseJson(winner);
    assertNoRawPlatformTokens(winnerTokens);
    assert.equal(
      upstreamCalls.filter(call => call.url.pathname === revokePath).length,
      revokeCallsBefore,
      'a losing claim must not revoke the winning credential family',
    );

    const protectedResponse = await mcpRequest(
      'account_status',
      {},
      `Bearer ${winnerTokens.access_token as string}`,
    );
    assert.equal(protectedResponse.status, 200);

    const replay = await redeem(authorization.clientId, authorization.code, authorization.verifier);
    assert.equal(replay.status, 400);
    assert.equal((await responseJson(replay)).error, 'invalid_grant');
  } finally {
    gate.release.resolve(undefined);
    tokenIssueGate = undefined;
    await winnerPromise?.catch(() => undefined);
  }
});

test('refresh tokens rotate with exact retry recovery, reject wrong bindings, and can be revoked', async () => {
  const authorization = await authorize();
  const initial = await responseJson(await redeem(authorization.clientId, authorization.code, authorization.verifier));
  assert.match(initial.access_token as string, /^v1a\./);
  assert.match(initial.refresh_token as string, /^v1r\./);
  assert.equal(accessCredentials.has(initial.access_token as string), false);
  assertNoRawPlatformTokens(initial);
  const firstRefresh = initial.refresh_token as string;
  assert.ok(firstRefresh);
  assert.doesNotMatch(JSON.stringify(initial), /dashboard-valid|server-test-public-mcp-platform-service-secret/);

  const wrongResource = await refresh(authorization.clientId, firstRefresh, 'https://mcp.spala.ai/other');
  assert.equal(wrongResource.status, 400);
  assert.equal((await responseJson(wrongResource)).error, 'invalid_grant');

  const otherClient = await beginAuthorization();
  const refreshCallsBeforeWrongClient = upstreamCalls.filter(call => (
    call.url.pathname === '/api/__internal/public-mcp/v1/token/refresh'
  )).length;
  const wrongClient = await refresh(otherClient.clientId, firstRefresh);
  assert.equal(wrongClient.status, 400);
  assert.equal((await responseJson(wrongClient)).error, 'invalid_grant');
  assert.equal(upstreamCalls.filter(call => (
    call.url.pathname === '/api/__internal/public-mcp/v1/token/refresh'
  )).length, refreshCallsBeforeWrongClient);

  const rotatedResponse = await refresh(authorization.clientId, firstRefresh);
  assert.equal(rotatedResponse.status, 200);
  const rotated = await responseJson(rotatedResponse);
  assert.ok(rotated.refresh_token);
  assert.notEqual(rotated.refresh_token, firstRefresh);
  assert.match(rotated.access_token as string, /^v1a\./);
  assert.match(rotated.refresh_token as string, /^v1r\./);
  assert.equal(accessCredentials.has(rotated.access_token as string), false);
  assertNoRawPlatformTokens(rotated);
  const refreshedProtected = await mcpRequest(
    'account_status',
    {},
    `Bearer ${rotated.access_token as string}`,
  );
  assert.equal(refreshedProtected.status, 200);
  assert.equal(accessCredentials.has(latestDelegatedAccessToken()), true);
  platformClockOffsetMs += 5_000;
  try {
    const replay = await refresh(authorization.clientId, firstRefresh);
    assert.equal(replay.status, 200);
    assert.deepEqual(
      await responseJson(replay),
      rotated,
      'a delayed retry must preserve wrappers and the original expires_in value',
    );
  } finally {
    platformClockOffsetMs -= 5_000;
  }
  const replayOutsideGrace = await refresh(authorization.clientId, firstRefresh);
  assert.equal(replayOutsideGrace.status, 400);
  assert.equal((await responseJson(replayOutsideGrace)).error, 'invalid_grant');

  const revokedRefresh = rotated.refresh_token as string;
  const revocation = await revoke(authorization.clientId, revokedRefresh, 'refresh_token');
  assert.equal(revocation.status, 200);
  assert.equal(await revocation.text(), '');
  const afterRevoke = await refresh(authorization.clientId, revokedRefresh);
  assert.equal(afterRevoke.status, 400);
  assert.equal((await responseJson(afterRevoke)).error, 'invalid_grant');

  const accessRevocation = await revoke(authorization.clientId, initial.access_token as string, 'access_token');
  assert.equal(accessRevocation.status, 200);
  const protectedAfterRevoke = await mcpRequest(
    'account_status',
    {},
    `Bearer ${initial.access_token as string}`,
  );
  assert.equal(protectedAfterRevoke.status, 401);
  assert.match(
    protectedAfterRevoke.headers.get('www-authenticate') || '',
    /^Bearer error="invalid_token", resource_metadata="https:\/\/mcp\.spala\.ai\/\.well-known\/oauth-protected-resource\/mcp", scope="api"$/,
  );

  const wrongClientRevocationCalls = upstreamCalls.filter(call => (
    call.url.pathname === '/api/__internal/public-mcp/v1/token/revoke'
  )).length;
  const wrongClientRevocation = await revoke(otherClient.clientId, initial.refresh_token as string, 'refresh_token');
  assert.equal(wrongClientRevocation.status, 401);
  assert.equal(upstreamCalls.filter(call => (
    call.url.pathname === '/api/__internal/public-mcp/v1/token/revoke'
  )).length, wrongClientRevocationCalls);

  const unknownTokenRevocation = await revoke(authorization.clientId, 'unknown-local-token-value', 'refresh_token');
  assert.equal(unknownTokenRevocation.status, 200);
  assert.equal(upstreamCalls.filter(call => (
    call.url.pathname === '/api/__internal/public-mcp/v1/token/revoke'
  )).length, wrongClientRevocationCalls);
});

test('ambiguous approval, issue, and refresh results are safely retryable', async () => {
  const pending = await beginAuthorization();
  const approvalProof = await createApprovalProof(pending.request);
  const approvalConsumePath = '/api/__internal/public-mcp/v1/approvals/consume';
  ambiguousPlatformRoutes.add(approvalConsumePath);
  try {
    const unavailableApproval = await fetch(`${baseUrl}/oauth/dashboard/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: pending.request, approvalProof }),
    });
    assert.equal(unavailableApproval.status, 503);
    assert.equal((await responseJson(unavailableApproval)).error, 'temporarily_unavailable');
  } finally {
    ambiguousPlatformRoutes.delete(approvalConsumePath);
  }
  const recoveredApproval = await fetch(`${baseUrl}/oauth/dashboard/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: pending.request, approvalProof }),
  });
  assert.equal(recoveredApproval.status, 200);
  const recoveredCallback = new URL((await responseJson(recoveredApproval)).redirectTo as string);
  const recoveredCode = recoveredCallback.searchParams.get('code');
  assert.ok(recoveredCode);
  const repeatedApproval = await fetch(`${baseUrl}/oauth/dashboard/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: pending.request, approvalProof }),
  });
  assert.equal(repeatedApproval.status, 200);
  assert.equal(
    new URL((await responseJson(repeatedApproval)).redirectTo as string).searchParams.get('code'),
    recoveredCode,
  );
  const otherRequest = await beginAuthorization();
  const crossRequestReplay = await fetch(`${baseUrl}/oauth/dashboard/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: otherRequest.request, approvalProof }),
  });
  assert.equal(crossRequestReplay.status, 400);
  assert.equal((await responseJson(crossRequestReplay)).error, 'invalid_grant');

  const tokenIssuePath = '/api/__internal/public-mcp/v1/token';
  transientPlatformRoutes.add(tokenIssuePath);
  try {
    const unavailableIssue = await redeem(pending.clientId, recoveredCode, pending.verifier);
    assert.equal(unavailableIssue.status, 503);
    assert.equal((await responseJson(unavailableIssue)).error, 'temporarily_unavailable');
  } finally {
    transientPlatformRoutes.delete(tokenIssuePath);
  }
  ambiguousPlatformRoutes.add(tokenIssuePath);
  const ambiguousIssue = await redeem(pending.clientId, recoveredCode, pending.verifier);
  assert.equal(ambiguousIssue.status, 503);
  assert.equal((await responseJson(ambiguousIssue)).error, 'temporarily_unavailable');
  const recoveredIssue = await redeem(pending.clientId, recoveredCode, pending.verifier);
  assert.equal(recoveredIssue.status, 200);
  const recoveredIssueBody = await responseJson(recoveredIssue);
  assertNoRawPlatformTokens(recoveredIssueBody);
  const repeatedIssue = await redeem(pending.clientId, recoveredCode, pending.verifier);
  assert.equal(repeatedIssue.status, 400);
  assert.equal((await responseJson(repeatedIssue)).error, 'invalid_grant');

  const authorization = await authorize();
  const initial = await responseJson(await redeem(authorization.clientId, authorization.code, authorization.verifier));
  const refreshToken = initial.refresh_token as string;

  const tokenRefreshPath = '/api/__internal/public-mcp/v1/token/refresh';
  transientPlatformRoutes.add(tokenRefreshPath);
  try {
    const unavailableRefresh = await refresh(authorization.clientId, refreshToken);
    assert.equal(unavailableRefresh.status, 503);
    assert.equal((await responseJson(unavailableRefresh)).error, 'temporarily_unavailable');
  } finally {
    transientPlatformRoutes.delete(tokenRefreshPath);
  }

  networkFailurePlatformRoutes.add(tokenRefreshPath);
  try {
    const networkRefresh = await refresh(authorization.clientId, refreshToken);
    assert.equal(networkRefresh.status, 503);
    assert.equal((await responseJson(networkRefresh)).error, 'temporarily_unavailable');
  } finally {
    networkFailurePlatformRoutes.delete(tokenRefreshPath);
  }

  ambiguousPlatformRoutes.add(tokenRefreshPath);
  const ambiguousRefresh = await refresh(authorization.clientId, refreshToken);
  assert.equal(ambiguousRefresh.status, 503);
  assert.equal((await responseJson(ambiguousRefresh)).error, 'temporarily_unavailable');
  const recoveredRefresh = await refresh(authorization.clientId, refreshToken);
  assert.equal(recoveredRefresh.status, 200);
  const recoveredRefreshBody = await responseJson(recoveredRefresh);
  assertNoRawPlatformTokens(recoveredRefreshBody);
  const repeatedRefresh = await refresh(authorization.clientId, refreshToken);
  assert.equal(repeatedRefresh.status, 400);
  assert.equal((await responseJson(repeatedRefresh)).error, 'invalid_grant');
});

test('public MCP startup remains anonymous while native clients receive protected-tool OAuth challenges', async () => {
  const nativeRegistration = await fetch(`${baseUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback'] }),
  });
  assert.equal(nativeRegistration.status, 201);
  const staleBearer = 'Bearer cross-audience-credential';
  const initializeParams = {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'boundary-test', version: '1.0.0' },
  };
  for (const authorization of [undefined, staleBearer]) {
    const initialized = await mcpRpc('initialize', initializeParams, authorization);
    assert.equal(initialized.status, 200);
    const initializeBody = await responseJson(initialized);
    assert.equal((initializeBody.result as Record<string, unknown>).protocolVersion, '2025-11-25');

    const listed = await mcpRpc('tools/list', {}, authorization);
    assert.equal(listed.status, 200);
    const tools = ((await responseJson(listed)).result as { tools: Array<{ name: string }> }).tools;
    assert.equal(tools.length, 16);

    for (const name of [
      'spala_help',
      'spala_get_onboarding',
      'spala_get_tool_map',
      'docs_search',
      'template_list',
      'addon_list',
    ]) {
      const response = await mcpRequest(name, {}, authorization);
      assert.equal(response.status, 200, `${name} public boundary`);
    }
  }

  const missingBearer = await mcpRequest('account_status', {});
  assert.equal(missingBearer.status, 401);
  const missingChallenge = missingBearer.headers.get('www-authenticate') || '';
  assert.match(
    missingChallenge,
    /^Bearer resource_metadata="https:\/\/mcp\.spala\.ai\/\.well-known\/oauth-protected-resource\/mcp", scope="api"$/,
  );
  assert.doesNotMatch(missingChallenge, /\berror=/);

  for (const authorization of [
    staleBearer,
    'Basic malformed-credential',
    'Bearer malformed credential',
  ]) {
    const protectedResponse = await mcpRequest('account_status', {}, authorization);
    assert.equal(protectedResponse.status, 401);
    assert.match(
      protectedResponse.headers.get('www-authenticate') || '',
      /^Bearer error="invalid_token", resource_metadata="https:\/\/mcp\.spala\.ai\/\.well-known\/oauth-protected-resource\/mcp", scope="api"$/,
    );
  }
});

test('protected tools return an api-scope challenge when the platform rejects scope', async () => {
  const authorization = await authorize();
  const token = await responseJson(await redeem(
    authorization.clientId,
    authorization.code,
    authorization.verifier,
  ));
  const publicAccessToken = token.access_token as string;
  const initial = await mcpRequest('account_status', {}, `Bearer ${publicAccessToken}`);
  assert.equal(initial.status, 200);
  const delegatedAccessToken = latestDelegatedAccessToken();
  insufficientScopeAccessTokens.add(delegatedAccessToken);
  try {
    const response = await mcpRequest('account_status', {}, `Bearer ${publicAccessToken}`);
    assert.equal(response.status, 403);
    assert.match(
      response.headers.get('www-authenticate') || '',
      /error="insufficient_scope".*scope="api"/,
    );
    const body = await responseJson(response);
    assert.equal(
      ((body.error as { data?: { requiredScope?: unknown } }).data)?.requiredScope,
      'api',
    );
  } finally {
    insufficientScopeAccessTokens.delete(delegatedAccessToken);
  }
});

test('disabled or unlinked principals receive a 401 Bearer challenge that starts reauthentication', async () => {
  const authorization = await authorize();
  const token = await responseJson(await redeem(
    authorization.clientId,
    authorization.code,
    authorization.verifier,
  ));
  const publicAccessToken = token.access_token as string;
  const first = await mcpRequest('account_status', {}, `Bearer ${publicAccessToken}`);
  assert.equal(first.status, 200);
  const delegatedAccessToken = latestDelegatedAccessToken();
  disabledPrincipalAccessTokens.add(delegatedAccessToken);
  try {
    const response = await mcpRequest('account_status', {}, `Bearer ${publicAccessToken}`);
    assert.equal(response.status, 401);
    assert.match(
      response.headers.get('www-authenticate') || '',
      /^Bearer error="invalid_token", resource_metadata="https:\/\/mcp\.spala\.ai\/\.well-known\/oauth-protected-resource\/mcp", scope="api"$/,
    );
    const body = await responseJson(response);
    assert.match(String((body.error as { message?: string }).message), /expired or was revoked/i);
    assert.doesNotMatch(JSON.stringify(body), /upstream_unavailable|service unavailable/i);
  } finally {
    disabledPrincipalAccessTokens.delete(delegatedAccessToken);
  }
});

test('project creation returns provisioning retry guidance and payment requires a human action', async () => {
  const valid = await authorize();
  const token = await responseJson(await redeem(valid.clientId, valid.code, valid.verifier));
  const created = await mcpRequest('project_create', { name: 'Created Project', organizationId: 'org-1' }, `Bearer ${token.access_token as string}`);
  const createdBody = await toolBody(created);
  assert.deepEqual(createdBody.provisioning, {
    state: 'creating',
    exactHandoffReady: false,
    message: 'Project creation completed, but an exact project MCP handoff is not ready yet.',
    retry: {
      tool: 'project_get_public_context',
      arguments: { projectId: 'project-created' },
      instruction: 'Retry this read-only tool after provisioning completes. Do not construct a project MCP URL.',
    },
  });

  const plan = await authorize('dashboard-plan');
  const planToken = await responseJson(await redeem(plan.clientId, plan.code, plan.verifier));
  const payment = await mcpRequest('project_create', { name: 'Paid Project', organizationId: 'org-1' }, `Bearer ${planToken.access_token as string}`);
  const paymentBody = await toolBody(payment);
  assert.match(String(paymentBody.message), /stop and ask the human/i);
  assert.equal((paymentBody.action as { type: string }).type, 'human_payment_required');
  assert.doesNotMatch(JSON.stringify(paymentBody), /private billing detail|dashboard-plan/);
});

test('public discovery distinguishes the protocol authorization endpoint from dashboard UI', async () => {
  const [agent, serverCard, handoffTest] = await Promise.all([
    responseJson(await fetch(`${baseUrl}/.well-known/agent.json`)),
    responseJson(await fetch(`${baseUrl}/.well-known/mcp/server-card.json`)),
    responseJson(await fetch(`${baseUrl}/.well-known/project-mcp-test.json`)),
  ]);
  for (const auth of [
    agent.oauth as Record<string, unknown>,
    handoffTest.auth as Record<string, unknown>,
  ]) {
    assert.equal(auth.authorizationEndpoint, 'https://mcp.spala.ai/oauth/authorize');
    assert.equal(auth.dashboardAuthorizationUrl, 'https://dashboard.spala.ai/mcp/authorize');
    assert.equal(
      auth.authorizationServerMetadata,
      'https://mcp.spala.ai/.well-known/oauth-authorization-server',
    );
  }
  assert.deepEqual(serverCard.serverInfo, {
    name: 'Spala Public MCP',
    version: '0.1.1',
  });
  assert.deepEqual(serverCard.authentication, {
    required: true,
    schemes: ['oauth2'],
  });
  assert.equal((serverCard.tools as Array<Record<string, unknown>>).length, 16);
  assert.deepEqual(serverCard.resources, []);
  assert.deepEqual(serverCard.prompts, []);
});

test('authenticated spala_start is published in discovery capabilities and startup instructions', async () => {
  const anonymous = await mcpRequest('spala_start', {});
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate') || '', /^Bearer /);

  const authorization = await authorize();
  const token = await responseJson(await redeem(authorization.clientId, authorization.code, authorization.verifier));
  const startup = await mcpRequest('spala_start', {}, `Bearer ${token.access_token as string}`);
  assert.equal(startup.status, 200);
  const startupBody = await toolBody(startup);
  assert.equal(startupBody.schemaVersion, 1);
  assert.equal(startupBody.phase, 'project_choice_required');
  assert.equal(startupBody.backendProvider, 'Spala');
  assert.equal(startupBody.selectedOrganizationId, 'org-1');
  assert.deepEqual(startupBody.nextAction, {
    type: 'ask_user_project_choice',
    choices: [{ projectId: 'project-1', name: 'Project One', organizationId: 'org-1', status: 'ready' }],
    allowCreateProject: true,
    allowCreateOrganization: true,
    afterSelectionTool: 'project_connect',
    rule: 'Do not automatically choose an existing project unless a valid local .spala/project.json binding identifies it.',
  });

  const [root, agent, mcp, serverCard, agentsMarkdown, llmsText] = await Promise.all([
    responseJson(await fetch(`${baseUrl}/`)),
    responseJson(await fetch(`${baseUrl}/.well-known/agent.json`)),
    responseJson(await fetch(`${baseUrl}/.well-known/mcp.json`)),
    responseJson(await fetch(`${baseUrl}/.well-known/mcp/server-card.json`)),
    (await fetch(`${baseUrl}/agents.md`)).text(),
    (await fetch(`${baseUrl}/llms.txt`)).text(),
  ]);
  const expectedPublicTools = [
    'spala_help',
    'spala_get_onboarding',
    'spala_get_tool_map',
    'docs_search',
    'template_list',
    'addon_list',
  ];
  for (const discovery of [root, agent, mcp]) {
    assert.deepEqual(discovery.publicTools || (discovery.tools as Record<string, unknown>).public, expectedPublicTools);
    const capabilities = discovery.toolCapabilities as Array<Record<string, unknown>>;
    assert.deepEqual(capabilities.find(tool => tool.name === 'spala_start'), {
      name: 'spala_start',
      requiresAuth: true,
      effect: 'read',
      available: true,
      authFailureHint: 'Missing, expired, or revoked bearer: HTTP 401 OAuth challenge; temporary service failure: HTTP 503.',
      purpose: 'Run versioned authenticated startup, verify account readiness, auto-scope one organization, and safely discover organizations and projects.',
    });
  }
  const cardStart = (serverCard.tools as Array<Record<string, unknown>>).find(tool => tool.name === 'spala_start');
  assert.ok(cardStart);
  const { outputSchema, ...cardStartWithoutOutput } = cardStart;
  assert.deepEqual(cardStartWithoutOutput, {
    name: 'spala_start',
    title: 'Start Spala',
    description: 'Run versioned authenticated startup, verify account readiness, auto-scope one organization, and safely discover organizations and projects.',
    inputSchema: {
      type: 'object',
      description: 'No arguments. Call this tool with an empty object.',
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  });
  assert.deepEqual((outputSchema as Record<string, unknown>).required, [
    'schemaVersion',
    'phase',
    'authenticated',
    'backendProvider',
    'user',
    'accountSetup',
    'organizations',
    'projects',
    'nextAction',
  ]);
  for (const instructions of [agentsMarkdown, llmsText]) {
    assert.match(instructions, /after OAuth.*call authenticated spala_start.*before/i);
    assert.match(instructions, /filesystem inspection.*skill loading.*web search.*planning.*design generation.*scaffolding.*coding.*testing.*QA/i);
    assert.match(instructions, /overrides frontend-builder and design workflows/i);
    assert.match(instructions, /Codex public init owns one native browser OAuth flow/i);
    assert.match(instructions, /If authorization later expires, run exactly one installer login command/i);
    assert.match(instructions, /Never inspect client credential stores, tokens, or browser storage/i);
    assert.match(instructions, /never hand-roll MCP HTTP\/JSON-RPC calls or helper scripts/i);
  }
});

test('install manifest exposes machine-readable 0.1.16 installer commands and secure Codex execution', async () => {
  const manifest = await responseJson(await fetch(`${baseUrl}/mcp/install-manifest`));
  const commands = manifest.commands as Record<string, unknown>;

  assert.equal(commands.installerNpm, 'npx --yes @spala-ai/mcp-install@0.1.16 init --client <client> --yes --json');
  assert.equal(commands.installerPnpm, 'pnpm dlx @spala-ai/mcp-install@0.1.16 init --client <client> --yes --json');
  assert.deepEqual(commands.installerNpmArgv, {
    init: ['npx', '--yes', '@spala-ai/mcp-install@0.1.16', 'init', '--client', '<client>', '--yes', '--json'],
    status: ['npx', '--yes', '@spala-ai/mcp-install@0.1.16', 'status', '--client', '<client>', '--json'],
  });
  assert.deepEqual(commands.installerPnpmArgv, {
    init: ['pnpm', 'dlx', '@spala-ai/mcp-install@0.1.16', 'init', '--client', '<client>', '--yes', '--json'],
    status: ['pnpm', 'dlx', '@spala-ai/mcp-install@0.1.16', 'status', '--client', '<client>', '--json'],
  });
  assert.equal(commands.codex, 'npx --yes @spala-ai/mcp-install@0.1.16 init --client codex --yes --json');
  const installer = manifest.installer as Record<string, unknown>;
  assert.equal(installer.version, '0.1.16');
  assert.deepEqual(installer.codexArgvPrefix, ['npx', '--yes', '@spala-ai/mcp-install@0.1.16']);
  assert.deepEqual((installer.execution as Record<string, unknown>).stdin, {
    tool: 'process_stdin',
    processSource: 'running_process',
    valueSource: 'bootstrap.consumeUrl',
    appendNewline: true,
    shell: false,
    argv: false,
  });
  assert.equal('codexAdd' in commands, false);
  assert.equal('codexLogin' in commands, false);
  assert.doesNotMatch(JSON.stringify(commands), /--public --yes/);
});

test('public response bodies, headers, metadata, and tool results never disclose the internal origin', async () => {
  const checks: Array<Promise<Response>> = [
    fetch(`${baseUrl}/`),
    fetch(`${baseUrl}/mcp`),
    fetch(`${baseUrl}/mcp/install-manifest`),
    fetch(`${baseUrl}/.well-known/agent.json`),
    fetch(`${baseUrl}/.well-known/mcp.json`),
    fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`),
    fetch(`${baseUrl}/.well-known/oauth-authorization-server/mcp`),
    fetch(`${baseUrl}/oauth/authorize`, { redirect: 'manual' }),
    mcpRequest('spala_get_onboarding', {}),
    mcpRequest('spala_get_tool_map', {}),
    mcpRequest('account_status', {}),
    mcpRequest('project_list', {}),
    mcpRequest('project_connect', { projectId: 'project-1', client: 'codex' }),
  ];
  for (const response of await Promise.all(checks)) {
    const transcript = `${[...response.headers.entries()].map(([key, value]) => `${key}: ${value}`).join('\n')}\n${await response.text()}`;
    assert.doesNotMatch(transcript, /api\.spala\.ai/);
  }
});
