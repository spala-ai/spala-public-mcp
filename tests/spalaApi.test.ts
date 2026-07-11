import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createSpalaApiClient, parseProjectMcpUrl, parseProjectRecord, ProjectHandoffUnavailableError } from '../src/spalaApi.js';

test('parseProjectMcpUrl accepts only explicit public HTTPS MCP endpoints', () => {
  assert.equal(parseProjectMcpUrl('https://project.example/mcp'), 'https://project.example/mcp');
  assert.equal(parseProjectMcpUrl('https://shared.example/project-a/mcp/'), 'https://shared.example/project-a/mcp');

  for (const value of [
    'http://project.example/mcp',
    'https://user:secret@project.example/mcp',
    'https://project.example/mcp?token=secret',
    'https://project.example/mcp#secret',
    'https://project.example/api',
    'https://127.0.0.1/mcp',
    'https://10.0.0.4/mcp',
    'https://[::]/mcp',
    'https://[::1]/mcp',
    'https://[fe80::1]/mcp',
    'https://[fc00::1]/mcp',
    'https://[fd00::1]/mcp',
    'https://[::ffff:127.0.0.1]/mcp',
    'https://[::ffff:10.0.0.1]/mcp',
    'https://[::ffff:169.254.1.1]/mcp',
    'https://[::ffff:192.168.1.1]/mcp',
    'https://project.example/a/../mcp',
    'https://project.example/a/%2e%2e/mcp',
    'javascript:alert(1)',
  ]) {
    assert.equal(parseProjectMcpUrl(value), undefined, value);
  }
});

test('parseProjectRecord does not recurse, derive, or accept access URLs', () => {
  assert.deepEqual(parseProjectRecord({
    id: 'project-1',
    name: 'Project One',
    accessUrl: 'https://project.example',
    nested: { mcpUrl: 'https://nested.example/mcp' },
  }), {
    id: 'project-1',
    name: 'Project One',
    slug: undefined,
    status: undefined,
    mcpUrl: undefined,
  });
});

test('project client keeps dry runs URL-free and fails closed for lookup', async () => {
  const config = loadConfig({
    PUBLIC_BASE_URL: 'https://mcp.spala.ai',
    SPALA_API_BASE_URL: 'https://api.spala.ai',
    DRY_RUN_PROJECT_CREATE: 'true',
  });
  const client = createSpalaApiClient(config);
  const project = await client.createProject({
    name: '  Secret Plan  ',
    template: '  api  ',
    description: '  Preview only  ',
  });
  assert.equal(project.dryRunOnly, true);
  assert.equal(project.name, 'Secret Plan');
  assert.equal(project.template, 'api');
  assert.equal(project.description, 'Preview only');
  assert.equal(project.mcpUrl, undefined);
  assert.equal((await client.resolveProjectAccess(project)).mcpUrl, undefined);
  await assert.rejects(client.createProject({ name: 'x'.repeat(121) }), /120/);
  await assert.rejects(client.createProject({ name: 'Plan', description: 'x'.repeat(2_001) }), /2000/);
  await assert.rejects(client.listProjects(), ProjectHandoffUnavailableError);
});
