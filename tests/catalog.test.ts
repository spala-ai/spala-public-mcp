import assert from 'node:assert/strict';
import test from 'node:test';
import { docsIndex, searchCatalog } from '../src/catalog.js';

test('docs_search recommends the current secure 0.1.13 Codex installer flow', () => {
  const result = searchCatalog(docsIndex, 'public mcp install command', 10).find(
    entry => entry.id === 'public-mcp-install-command',
  );

  assert.ok(result);
  assert.match(result.summary, /npx --yes @spala-ai\/mcp-install@0\.1\.13 init --client codex --yes --json/);
  assert.match(result.summary, /npx --yes @spala-ai\/mcp-install@0\.1\.13 status --client codex --json/);
  assert.match(result.summary, /exact JSON steps/);
  assert.match(result.summary, /project_connect once for workspace binding/);
  assert.match(result.summary, /tty:true and shell:false/);
  assert.match(result.summary, /bootstrap\.consumeUrl.*process stdin tool/);
  assert.match(result.summary, /Legacy flags remain compatibility-only/);
  assert.doesNotMatch(result.summary, /npx @spala-ai\/mcp-install --public --yes/);
});
