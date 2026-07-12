import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';

process.env['PUBLIC_BASE_URL'] = 'https://mcp.spala.ai';
process.env['SPALA_API_BASE_URL'] = 'https://api.spala.ai';
process.env['SPALA_DASHBOARD_URL'] = 'https://dashboard.spala.ai';
process.env['SPALA_DOCS_URL'] = 'https://docs.spala.ai/agents/mcp';
process.env['CORS_ALLOWED_ORIGINS'] = 'https://client.example';
process.env['DRY_RUN_PROJECT_CREATE'] = 'true';
process.env['MCP_BODY_LIMIT_BYTES'] = '16384';
process.env['MCP_RATE_LIMIT_MAX'] = '1000';

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
});

function rpcBody(method: string, params: unknown = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
}

async function mcpRequest(method: string, params: unknown, authorization?: string, protocolVersion?: string) {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
      ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
    },
    body: rpcBody(method, params),
  });
}

async function rawMcpRequest(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text.split('\n').find(line => line.startsWith('data: '))?.slice(6);
    if (!data) throw new Error(`Missing SSE data: ${text}`);
    return JSON.parse(data) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

test('CORS uses public non-credentialed safe-origin handling', async () => {
  const allowed = await fetch(`${baseUrl}/health`, { headers: { origin: 'https://client.example' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('x-powered-by'), null);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://client.example');
  assert.equal(allowed.headers.get('access-control-allow-credentials'), null);

  const arbitrarySafe = await fetch(`${baseUrl}/health`, { headers: { origin: 'https://example.com' } });
  assert.equal(arbitrarySafe.status, 200);
  assert.equal(arbitrarySafe.headers.get('access-control-allow-origin'), 'https://example.com');
  assert.equal(arbitrarySafe.headers.get('access-control-allow-credentials'), null);

  const unsafe = await fetch(`${baseUrl}/health`, { headers: { origin: 'http://evil.example' } });
  assert.equal(unsafe.status, 403);
  assert.equal(unsafe.headers.get('access-control-allow-origin'), null);

  const noOrigin = await fetch(`${baseUrl}/health`);
  assert.equal(noOrigin.headers.get('access-control-allow-origin'), null);

  const preflight = await fetch(`${baseUrl}/mcp`, {
    method: 'OPTIONS',
    headers: { origin: 'https://example.com' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://example.com');
  assert.match(preflight.headers.get('access-control-allow-headers') || '', /Mcp-Protocol-Version/);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
});

test('OAuth discovery is canonical and limited to api scope', async () => {
  const resource = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(resource.status, 200);
  const resourceMetadata = await resource.json() as Record<string, unknown>;
  assert.equal(typeof resourceMetadata.note, 'string');
  delete resourceMetadata.note;
  assert.deepEqual(resourceMetadata, {
    resource: 'https://mcp.spala.ai/mcp',
    authorization_servers: ['https://api.spala.ai/mcp'],
    bearer_methods_supported: ['header'],
    scopes_supported: ['api'],
    resource_documentation: 'https://docs.spala.ai/agents/mcp',
    agent_start_url: 'https://spala.ai/agents.md',
    maintainer: {
      name: 'Spala AI',
      contact: 'vitali@spala.ai',
      website: 'https://spala.ai/',
    },
  });

  const metadata = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`, { redirect: 'manual' });
  assert.equal(metadata.status, 308);
  assert.equal(metadata.headers.get('location'), 'https://api.spala.ai/.well-known/oauth-authorization-server/mcp');
});

test('install manifest includes Codex OAuth login and user-scoped Gemini commands', async () => {
  const response = await fetch(`${baseUrl}/mcp/install-manifest`);
  assert.equal(response.status, 200);
  const manifest = await response.json() as { commands: Record<string, string> };
  assert.equal(manifest.commands.codexLogin, 'codex mcp login spala_public_mcp --scopes api');
  assert.equal(
    manifest.commands.geminiCliUser,
    'gemini mcp add --scope user --transport http spala_public_mcp "https://mcp.spala.ai/mcp"',
  );
});

test('MCP protocol headers reject unsupported versions and expose accepted versions', async () => {
  const unsupported = await mcpRequest('ping', {}, undefined, '2099-01-01');
  assert.equal(unsupported.status, 400);
  const unsupportedBody = await responseJson(unsupported);
  assert.deepEqual((unsupportedBody.error as { data: { supportedProtocolVersions: string[] } }).data.supportedProtocolVersions, ['2025-11-25', '2025-06-18']);

  const legacy = await mcpRequest('ping', {}, undefined, '2025-03-26');
  assert.equal(legacy.status, 400);
  assert.deepEqual(((await responseJson(legacy)).error as { data: { supportedProtocolVersions: string[] } }).data.supportedProtocolVersions, ['2025-11-25', '2025-06-18']);

  const accepted = await mcpRequest('ping', {}, undefined, '2025-11-25');
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('mcp-protocol-version'), '2025-11-25');
});

test('initialize rejects legacy protocol revisions and accepts the standalone minimum', async () => {
  const initialize = (protocolVersion: string) => rawMcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'qa-test-client', version: '1.0.0' },
    },
  });

  const legacy = await initialize('2025-03-26');
  assert.equal(legacy.status, 400);
  const legacyBody = await responseJson(legacy);
  assert.equal((legacyBody.error as { code: number }).code, -32000);
  assert.deepEqual((legacyBody.error as { data: { supportedProtocolVersions: string[] } }).data.supportedProtocolVersions, ['2025-11-25', '2025-06-18']);

  const minimum = await initialize('2025-06-18');
  assert.equal(minimum.status, 200);
  const minimumBody = await responseJson(minimum);
  assert.equal(((minimumBody.result as { protocolVersion: string }).protocolVersion), '2025-06-18');
});

test('project auth challenge advertises canonical resource metadata and api scope', async () => {
  const response = await mcpRequest('tools/call', { name: 'project_list', arguments: {} });
  assert.equal(response.status, 401);
  const challenge = response.headers.get('www-authenticate') || '';
  assert.match(challenge, /resource_metadata="https:\/\/mcp\.spala\.ai\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.match(challenge, /scope="api"/);

  const wrongScheme = await mcpRequest('tools/call', { name: 'project_list', arguments: {} }, 'Basic abc123');
  assert.equal(wrongScheme.status, 401);
});

test('bearer credentials fail closed before project tool processing without token leakage', async () => {
  const secret = 'opaque-secret-token';
  for (const name of ['project_list', 'project_create', 'project_select']) {
    const response = await mcpRequest(
      'tools/call',
      { name, arguments: name === 'project_create' ? { name: 'Plan' } : {} },
      `Bearer ${secret}`,
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), null);
    const text = JSON.stringify(await responseJson(response));
    assert.match(text, /auth_validation_unavailable/);
    assert.doesNotMatch(text, /retryable/);
    assert.doesNotMatch(text, new RegExp(secret));
    assert.doesNotMatch(text, /project_handoff_contract_unavailable|\/api\/projects/);
  }
});

test('project tool notifications fail closed without responses or execution', async () => {
  for (const authorization of [undefined, 'Bearer opaque-secret-token']) {
    const response = await rawMcpRequest({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'project_list', arguments: {} },
    }, authorization ? { authorization } : {});
    assert.equal(response.status, 202);
    assert.equal(await response.text(), '');
  }
});

test('JSON-RPC framing distinguishes parse errors, invalid requests, primitives, params arrays, and batches', async () => {
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  const malformed = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers, body: '{"jsonrpc":' });
  assert.equal(malformed.status, 400);
  assert.equal(((await responseJson(malformed)).error as { code: number }).code, -32700);

  for (const body of [
    'true',
    'false',
    'null',
    '1',
    '"ping"',
    '[]',
    `[${rpcBody('ping')}]`,
    JSON.stringify({ method: 'ping', id: 1 }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: [] }),
    JSON.stringify({ jsonrpc: '2.0', id: true, method: 'ping' }),
  ]) {
    const response = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers, body });
    assert.equal(response.status, 400);
    const invalid = await responseJson(response);
    assert.equal((invalid.error as { code: number }).code, -32600);
    if (body.includes('"id":true')) assert.equal(invalid.id, null);
  }
});

test('MCP rejects non-application/json bodies with a JSON-RPC invalid-request envelope', async () => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'text/plain' },
    body: rpcBody('ping'),
  });
  assert.equal(response.status, 415);
  const body = await responseJson(response);
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.id, null);
  assert.equal((body.error as { code: number }).code, -32600);
});

test('oversized MCP JSON uses a JSON-RPC error envelope', async () => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: rpcBody('ping', { padding: 'x'.repeat(17_000) }),
  });
  assert.equal(response.status, 413);
  const body = await responseJson(response);
  assert.equal(body.jsonrpc, '2.0');
  assert.equal((body.error as { code: number }).code, -32600);
});
