import assert from 'node:assert/strict';
import test from 'node:test';
import { docsIndex, searchCatalog } from '../src/catalog.js';

test('docs_search discovers the official native agent integration repository', () => {
  const result = searchCatalog(docsIndex, 'agent integrations plugin marketplace', 5).find(
    entry => entry.id === 'native-agent-integrations',
  );

  assert.ok(result);
  assert.equal(result.url, 'https://github.com/spala-ai/agent-integrations');
});

test('docs_search recommends the current secure 0.1.25 Codex installer flow', () => {
  const result = searchCatalog(docsIndex, 'public mcp install command', 10).find(
    entry => entry.id === 'public-mcp-install-command',
  );

  assert.ok(result);
  assert.match(result.summary, /npx --yes @spala-ai\/mcp-install@0\.1\.25 init --client codex --yes --json/);
  assert.match(result.summary, /npx --yes @spala-ai\/mcp-install@0\.1\.25 status --client codex --json/);
  assert.match(result.summary, /exact JSON steps/);
  assert.match(result.summary, /project_connect for workspace binding/);
  assert.match(result.summary, /tty:true and shell:false/);
  assert.match(result.summary, /bootstrap\.consumeUrl.*process stdin tool/);
  assert.match(result.summary, /Claude Code.*local verifier.*without project OAuth/);
  assert.match(result.summary, /Legacy flags remain compatibility-only/);
  assert.doesNotMatch(result.summary, /npx @spala-ai\/mcp-install --public --yes/);
});
