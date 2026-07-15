import assert from 'node:assert/strict';
import test from 'node:test';
import { docsIndex, searchCatalog } from '../src/catalog.js';

test('docs_search recommends the current 0.1.8 public MCP installer flow', () => {
  const result = searchCatalog(docsIndex, 'public mcp install command', 10).find(
    entry => entry.id === 'public-mcp-install-command',
  );

  assert.ok(result);
  assert.match(result.summary, /pnpm dlx @spala-ai\/mcp-install init --client <client> --yes --json/);
  assert.match(result.summary, /pnpm dlx @spala-ai\/mcp-install status --client <client> --json with the same client/);
  assert.match(result.summary, /exact JSON steps/);
  assert.match(result.summary, /project_connect once for workspace binding/);
  assert.match(result.summary, /Legacy flags remain compatibility-only/);
  assert.doesNotMatch(result.summary, /npx @spala-ai\/mcp-install --public --yes/);
});
