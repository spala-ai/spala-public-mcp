import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const nativeFetch = globalThis.fetch;
const upstreamCalls: Array<{ url: URL; method: string; authorization: string; body?: string }> = [];
const expiredDashboardTokens = new Set<string>();
const revokedAccessTokens = new Set<string>();
const projectConfigFailures = new Set<string>();
const replayStatePath = mkdtempSync(join(tmpdir(), 'mcp-spala-ai-server-replay-'));

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  const authorization = new Headers(init?.headers).get('authorization') || '';
  if (url.origin !== 'https://api.spala.ai' && url.origin !== 'https://project-one.example') {
    return nativeFetch(input, init);
  }
  upstreamCalls.push({
    url,
    method: init?.method || 'GET',
    authorization,
    body: typeof init?.body === 'string' ? init.body : undefined,
  });
  if (url.origin === 'https://project-one.example') {
    if (authorization !== 'Bearer project-entry-token') {
      return Response.json({ error: 'invalid_project_token' }, { status: 401 });
    }
    if (url.pathname === '/project/config' && init?.method === 'POST') {
      if (projectConfigFailures.has('project-entry-token')) {
        return Response.json({ error: { code: 'forbidden', message: 'project-entry-token must not escape' } }, { status: 403 });
      }
      return Response.json({ success: true });
    }
    if (url.pathname === '/mcp/agent-instructions' && init?.method === 'POST') {
      return Response.json({
        consumeUrl: 'https://project-one.example/mcp/agent-instructions/mcp_agent_test/consume',
      }, { status: 201 });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  const dashboardToken = authorization.replace(/^Bearer /, '');
  if (!['dashboard-valid', 'dashboard-plan'].includes(dashboardToken) || expiredDashboardTokens.has(dashboardToken)) {
    return Response.json({ error: 'invalid_token' }, { status: 401 });
  }
  if (url.pathname === '/api/me') {
    return Response.json({
      user: { id: 'user-1', email: 'user@example.test' },
      organizations: [{ id: 'org-1', name: 'First organization' }],
    });
  }
  if (url.pathname === '/api/projects' && init?.method === 'GET') {
    return Response.json({ projects: [{ id: 'project-1', project_name: 'Project One', status: 'ready', subdomain: 'project-one.example' }] });
  }
  if (url.pathname === '/api/projects' && init?.method === 'POST') {
    if (dashboardToken === 'dashboard-plan') {
      return Response.json({ error: { code: 'plan_restricted', message: 'private billing detail' } }, { status: 403 });
    }
    return Response.json({ id: 'project-created', project_name: 'Created Project', status: 'creating', subdomain: 'project-created' }, { status: 201 });
  }
  if (url.pathname === '/api/projects/project-1/mcp-handoff') {
    return Response.json({
      projectId: 'project-1',
      projectName: 'Project One',
      status: 'ready',
      projectUrl: 'https://project-one.example',
      mcpEnabled: true,
      mcpUrl: 'https://project-one.example/mcp/?scope=builder%2Cproject%2Cdata',
      manifestUrl: 'https://project-one.example/mcp/install-manifest?scope=builder%2Cproject%2Cdata',
    });
  }
  if (url.pathname === '/api/projects/project-1' && init?.method === 'GET') {
    return Response.json({ id: 'project-1', project_name: 'Project One', status: 'ready', subdomain: 'project-one.example' });
  }
  if (url.pathname === '/api/projects/project-1/access-url' && init?.method === 'GET') {
    if (revokedAccessTokens.has(dashboardToken)) {
      return Response.json({ error: 'invalid_token' }, { status: 401 });
    }
    const encodedUrl = Buffer.from('https://project-one.example').toString('base64');
    return Response.json({
      url: `https://app.spala.ai/?url=${encodeURIComponent(encodedUrl)}&auth_token=project-entry-token`,
    });
  }
  return Response.json({ error: 'not_found' }, { status: 404 });
}) as typeof fetch;

process.env['PUBLIC_BASE_URL'] = 'https://mcp.spala.ai';
process.env['SPALA_API_BASE_URL'] = 'https://api.spala.ai';
process.env['PUBLIC_OAUTH_ENCRYPTION_SECRET'] = 'server-test-public-oauth-encryption-secret-32-bytes';
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

async function toolBody(response: Response): Promise<Record<string, unknown>> {
  const envelope = await responseJson(response);
  const result = envelope.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

async function authorize(dashboardToken = 'dashboard-valid') {
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

  const approval = await fetch(`${baseUrl}/oauth/dashboard/approve`, {
    method: 'POST',
    headers: { authorization: `Bearer ${dashboardToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ request }),
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

async function redeem(clientId: string, code: string, verifier: string): Promise<Response> {
  return fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:3939/callback',
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

test('OAuth metadata advertises public endpoints and no device flow', async () => {
  const response = await fetch(`${baseUrl}/.well-known/oauth-authorization-server/mcp`);
  assert.equal(response.status, 200);
  assert.deepEqual(await responseJson(response), {
    issuer: 'https://mcp.spala.ai',
    authorization_endpoint: 'https://mcp.spala.ai/oauth/authorize',
    token_endpoint: 'https://mcp.spala.ai/oauth/token',
    registration_endpoint: 'https://mcp.spala.ai/oauth/register',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['api'],
  });
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
  assert.equal(token.scope, 'api');
  assert.equal(token.resource, 'https://mcp.spala.ai/mcp');
  assert.doesNotMatch(JSON.stringify(token), /dashboard-valid|api\.spala\.ai/);

  const listed = await mcpRequest('project_list', { organizationId: 'org-1' }, `Bearer ${accessToken}`);
  assert.equal(listed.status, 200);
  assert.deepEqual(await toolBody(listed), {
    organization: { id: 'org-1', name: 'First organization' },
    projects: [{ id: 'project-1', name: 'Project One', status: 'ready', subdomain: 'project-one.example', organizationId: 'org-1' }],
  });
  assert.ok(upstreamCalls.some(call => call.url.pathname === '/api/me' && call.authorization === 'Bearer dashboard-valid'));
  assert.ok(upstreamCalls.some(call => call.url.pathname === '/api/projects' && call.authorization === 'Bearer dashboard-valid'));
});

test('account status, project preparation, workspace binding, and revoked-session reauthentication work end to end', async () => {
  const authorization = await authorize();
  const token = await responseJson(await redeem(authorization.clientId, authorization.code, authorization.verifier));
  const bearer = `Bearer ${token.access_token as string}`;

  const status = await mcpRequest('account_status', {}, bearer);
  assert.equal(status.status, 200);
  assert.deepEqual(await toolBody(status), {
    authenticated: true,
    tokenStatus: 'active',
    subject: 'user-1',
    user: { id: 'user-1', email: 'user@example.test' },
    organizations: [{ id: 'org-1', name: 'First organization' }],
    next: 'Reuse the project in .spala/project.json when present; otherwise call project_list before deciding whether project_create is needed.',
  });

  const connected = await mcpRequest('project_connect', { projectId: 'project-1', client: 'codex' }, bearer);
  assert.equal(connected.status, 200);
  const connectedBody = await toolBody(connected);
  assert.equal(connectedBody.mcpUrl, 'https://project-one.example/mcp?scope=builder%2Cproject%2Cdata');
  assert.equal(connectedBody.workspaceOnly, true);
  assert.equal(connectedBody.preparedByProjectBackend, true);
  assert.equal(connectedBody.bootstrapPreparedByProjectBackend, true);
  const plan = connectedBody.installPlan as { argv: string[]; globalInstall: boolean; workspaceScope: string };
  assert.deepEqual(plan.argv.slice(0, 5), ['pnpm', 'dlx', '@spala-ai/mcp-install', 'project', 'bind']);
  assert.equal(plan.argv[plan.argv.indexOf('--project-id') + 1], 'project-1');
  assert.equal(plan.argv[plan.argv.indexOf('--project-url') + 1], 'https://project-one.example');
  assert.equal(plan.argv[plan.argv.indexOf('--url') + 1], connectedBody.mcpUrl);
  assert.equal(plan.argv[plan.argv.indexOf('--name') + 1], connectedBody.serverName);
  assert.equal(plan.argv[plan.argv.indexOf('--client') + 1], 'codex');
  assert.equal(plan.argv[plan.argv.indexOf('--install-scope') + 1], 'workspace');
  assert.equal(plan.argv.includes('--bootstrap-stdin'), true);
  assert.equal(plan.argv.includes('--bootstrap-url'), false);
  assert.equal(plan.argv.includes('https://project-one.example/mcp/agent-instructions/mcp_agent_test/consume'), false);
  assert.equal((connectedBody.bootstrap as Record<string, unknown>).consumeUrl, 'https://project-one.example/mcp/agent-instructions/mcp_agent_test/consume');
  assert.equal(plan.globalInstall, false);
  assert.equal(plan.workspaceScope, 'workspace');
  assert.ok(upstreamCalls.some(call => (
    call.url.pathname === '/api/projects/project-1/access-url'
    && call.method === 'GET'
    && call.authorization === 'Bearer dashboard-valid'
  )));
  assert.equal(upstreamCalls.some(call => call.url.pathname === '/api/projects/project-1/mcp/prepare'), false);
  assert.deepEqual(
    upstreamCalls.filter(call => call.url.origin === 'https://project-one.example').map(call => `${call.method} ${call.url.pathname}`),
    ['POST /project/config', 'POST /mcp/agent-instructions'],
  );
  assert.ok(upstreamCalls.filter(call => call.url.origin === 'https://project-one.example')
    .every(call => call.authorization === 'Bearer project-entry-token'));
  assert.equal((connectedBody.handoff as Record<string, unknown>).bootstrapConsumeUrl, undefined);
  assert.equal(JSON.stringify(connectedBody).split('mcp_agent_test').length - 1, 1);
  assert.doesNotMatch(JSON.stringify(connectedBody), /dashboard-valid|project-entry-token|api\.spala\.ai/);

  const callsBeforeConfigFailure = upstreamCalls.length;
  projectConfigFailures.add('project-entry-token');
  try {
    const configFailure = await mcpRequest('project_connect', { projectId: 'project-1', client: 'codex' }, bearer);
    assert.equal(configFailure.status, 200);
    const failureBody = await toolBody(configFailure);
    assert.equal(failureBody.category, 'forbidden');
    assert.doesNotMatch(JSON.stringify(failureBody), /project-entry-token|api\.spala\.ai/);
    assert.deepEqual(upstreamCalls.slice(callsBeforeConfigFailure)
      .filter(call => call.url.origin === 'https://project-one.example')
      .map(call => `${call.method} ${call.url.pathname}`), ['POST /project/config']);
  } finally {
    projectConfigFailures.delete('project-entry-token');
  }

  revokedAccessTokens.add('dashboard-valid');
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
    revokedAccessTokens.delete('dashboard-valid');
  }

  expiredDashboardTokens.add('dashboard-valid');
  try {
    const revoked = await mcpRequest('account_status', {}, bearer);
    assert.equal(revoked.status, 401);
    assert.match(revoked.headers.get('www-authenticate') || '', /^Bearer /);
    const revokedBody = await responseJson(revoked);
    assert.match(String((revokedBody.error as { message?: string }).message), /expired or was revoked/i);
    assert.doesNotMatch(JSON.stringify(revokedBody), /upstream_unavailable|service unavailable/i);
  } finally {
    expiredDashboardTokens.delete('dashboard-valid');
  }
});

test('authorization rejects replay, PKCE mismatch, dashboard auth failure, and unregistered redirects', async () => {
  const { clientId, verifier, code } = await authorize();
  const wrongPkce = await redeem(clientId, code, 'x'.repeat(64));
  assert.equal(wrongPkce.status, 400);
  assert.equal((await responseJson(wrongPkce)).error, 'invalid_grant');

  const redeemed = await redeem(clientId, code, verifier);
  assert.equal(redeemed.status, 200);
  const replay = await redeem(clientId, code, verifier);
  assert.equal(replay.status, 400);
  assert.equal((await responseJson(replay)).error, 'invalid_grant');

  const invalidDashboard = await fetch(`${baseUrl}/oauth/dashboard/approve`, {
    method: 'POST',
    headers: { authorization: 'Bearer invalid-dashboard', 'content-type': 'application/json' },
    body: JSON.stringify({ request: 'not-a-ticket' }),
    redirect: 'manual',
  });
  assert.equal(invalidDashboard.status, 401);

  const redirectAttempt = await fetch(`${baseUrl}/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=http%3A%2F%2F127.0.0.1%3A4444%2Fcallback&response_type=code&resource=https%3A%2F%2Fmcp.spala.ai%2Fmcp&scope=api&state=state&code_challenge_method=S256&code_challenge=${challenge(verifier)}`, { redirect: 'manual' });
  assert.equal(redirectAttempt.status, 400);
  assert.equal(redirectAttempt.headers.get('location'), null);

  const phishingRegistration = await fetch(`${baseUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://evil.example/callback'] }),
  });
  assert.equal(phishingRegistration.status, 400);
  assert.equal((await responseJson(phishingRegistration)).error, 'invalid_request');
});

test('refresh tokens rotate and return invalid_grant when the dashboard session expires', async () => {
  const authorization = await authorize();
  const initial = await responseJson(await redeem(authorization.clientId, authorization.code, authorization.verifier));
  const firstRefresh = initial.refresh_token as string;
  assert.ok(firstRefresh);
  assert.doesNotMatch(JSON.stringify(initial), /dashboard-valid/);

  const wrongResource = await refresh(authorization.clientId, firstRefresh, 'https://mcp.spala.ai/other');
  assert.equal(wrongResource.status, 400);
  assert.equal((await responseJson(wrongResource)).error, 'invalid_grant');

  const rotatedResponse = await refresh(authorization.clientId, firstRefresh);
  assert.equal(rotatedResponse.status, 200);
  const rotated = await responseJson(rotatedResponse);
  assert.ok(rotated.refresh_token);
  assert.notEqual(rotated.refresh_token, firstRefresh);
  const replay = await refresh(authorization.clientId, firstRefresh);
  assert.equal(replay.status, 400);
  assert.equal((await responseJson(replay)).error, 'invalid_grant');

  const expired = await authorize();
  const expiredTokens = await responseJson(await redeem(expired.clientId, expired.code, expired.verifier));
  expiredDashboardTokens.add('dashboard-valid');
  try {
    const expiredRefresh = await refresh(expired.clientId, expiredTokens.refresh_token as string);
    assert.equal(expiredRefresh.status, 400);
    assert.equal((await responseJson(expiredRefresh)).error, 'invalid_grant');
  } finally {
    expiredDashboardTokens.delete('dashboard-valid');
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
    serverCard.authentication as Record<string, unknown>,
    handoffTest.auth as Record<string, unknown>,
  ]) {
    assert.equal(auth.authorizationEndpoint, 'https://mcp.spala.ai/oauth/authorize');
    assert.equal(auth.dashboardAuthorizationUrl, 'https://dashboard.spala.ai/mcp/authorize');
  }
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
