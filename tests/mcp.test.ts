import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { createSpalaPublicMcpServer } from '../src/mcp.js';
import type { CreateProjectInput, SpalaApiClient } from '../src/spalaApi.js';

const config = loadConfig({
  PUBLIC_BASE_URL: 'https://mcp.spala.ai',
  SPALA_API_BASE_URL: 'https://api.spala.ai',
  SPALA_DASHBOARD_URL: 'https://dashboard.spala.ai',
  DRY_RUN_PROJECT_CREATE: 'true',
});

async function withVerifiedClient<T>(api: SpalaApiClient, run: (client: Client) => Promise<T>): Promise<T> {
  const server = createSpalaPublicMcpServer(config, api, {
    verifiedPrincipal: { subject: 'test-user' },
  });
  const client = new Client({ name: 'mcp-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const item = result.content[0];
  assert.ok(item && item.type === 'text');
  return item.text;
}

test('tools/list advertises both project selectors and truthful auth metadata', async () => {
  const api: SpalaApiClient = {
    async listProjects() { return []; },
    async createProject() { throw new Error('not called'); },
    async resolveProjectAccess(project) { return project; },
  };

  await withVerifiedClient(api, async client => {
    const { tools } = await client.listTools();
    for (const name of ['project_select', 'project_get_mcp_manifest', 'project_get_public_context']) {
      const tool = tools.find(candidate => candidate.name === name);
      assert.ok(tool, name);
      assert.deepEqual(Object.keys(tool.inputSchema.properties || {}).sort(), ['projectId', 'slug']);
      assert.equal(Array.isArray(tool.inputSchema.oneOf), true);
      assert.deepEqual(
        (tool.inputSchema.oneOf as Array<{ required: string[] }>).map(branch => branch.required).sort(),
        [['projectId'], ['slug']],
      );
      assert.deepEqual(tool._meta?.['securitySchemes'], [{ type: 'oauth2', scopes: ['api'] }]);
      assert.deepEqual(tool._meta?.['spala.ai/auth'], {
        required: true,
        tokenValidation: 'unavailable',
        available: false,
        missingBearerBehavior: 'HTTP 401 with WWW-Authenticate OAuth challenge',
        bearerPresentBehavior: 'HTTP 503 auth_validation_unavailable before tool processing',
        protectedResourceMetadata: 'https://mcp.spala.ai/.well-known/oauth-protected-resource/mcp',
      });
    }
  });
});

test('project selectors enforce exactly one field at runtime before API access', async () => {
  let listCalls = 0;
  const api: SpalaApiClient = {
    async listProjects() { listCalls += 1; return []; },
    async createProject() { throw new Error('not called'); },
    async resolveProjectAccess(project) { return project; },
  };

  await withVerifiedClient(api, async client => {
    for (const args of [{}, { projectId: 'p1', slug: 'one' }]) {
      const result = await client.callTool({ name: 'project_select', arguments: args });
      assert.equal(result.isError, true);
      assert.match(resultText(result), /exactly one of projectId or slug/i);
    }
    assert.equal(listCalls, 0);
  });
});

test('dry-run project inputs are trimmed and bounded by the MCP contract', async () => {
  let received: CreateProjectInput | undefined;
  const api: SpalaApiClient = {
    async listProjects() { return []; },
    async createProject(input) {
      received = input;
      return { id: 'dry-run-plan', name: input.name, dryRunOnly: true };
    },
    async resolveProjectAccess(project) { return project; },
  };

  await withVerifiedClient(api, async client => {
    const valid = await client.callTool({
      name: 'project_create',
      arguments: { name: '  Plan  ', template: '  api  ', description: '  Preview only  ' },
    });
    assert.notEqual(valid.isError, true);
    assert.deepEqual(received, { name: 'Plan', template: 'api', description: 'Preview only' });

    const oversized = await client.callTool({
      name: 'project_create',
      arguments: { name: 'x'.repeat(121) },
    });
    assert.equal(oversized.isError, true);
    assert.match(resultText(oversized), /120|too big|too long/i);
  });
});
