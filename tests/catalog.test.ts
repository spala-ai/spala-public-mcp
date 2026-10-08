import assert from 'node:assert/strict';
import test from 'node:test';
import { addonCatalog, docsIndex, searchCatalog } from '../src/catalog.js';

test('docs_search discovers the official native agent integration repository', () => {
  const result = searchCatalog(docsIndex, 'agent integrations plugin marketplace', 5).find(
    entry => entry.id === 'native-agent-integrations',
  );

  assert.ok(result);
  assert.equal(result.url, 'https://github.com/spala-ai/agent-integrations');
});

test('docs_search recommends latest-channel maintenance and exact-version project binding', () => {
  const result = searchCatalog(docsIndex, 'public mcp install command', 10).find(
    entry => entry.id === 'public-mcp-install-command',
  );

  assert.ok(result);
  assert.match(result.summary, /npx --yes @spala-ai\/mcp-install@latest init --client codex --yes --json/);
  assert.match(result.summary, /npx --yes @spala-ai\/mcp-install@latest status --client codex --json/);
  assert.match(result.summary, /prevents persistent recovery guidance from freezing a client/);
  assert.match(result.summary, /exact-version plan/);
  assert.match(result.summary, /exact JSON steps/);
  assert.match(result.summary, /project_connect for workspace binding/);
  assert.match(result.summary, /tty:true and shell:false/);
  assert.match(result.summary, /bootstrap\.consumeUrl.*process stdin tool/);
  assert.match(result.summary, /Claude Code.*local verifier.*without project OAuth/);
  assert.match(result.summary, /Legacy flags remain compatibility-only/);
  assert.doesNotMatch(result.summary, /npx @spala-ai\/mcp-install --public --yes/);
});


test('embedding discovery recommends native Vector storage and search', () => {
  const result = searchCatalog(docsIndex, 'pgvector')[0];
  assert.equal(result.id, 'native-vector-search');
  assert.match(result.summary, /Vector fields and native Similarity Search/);
  assert.match(result.summary, /owner\/tenant filters/);
  assert.match(result.summary, /administrator setup/);
});

for (const query of ['Telegram CRM', 'telegram bot']) {
  test(`addon discovery finds the native integration for ${query}`, () => {
    assert.equal(searchCatalog(addonCatalog, query, 5)[0].id, 'telegram');
    const guide = searchCatalog(docsIndex, 'addon telegram', 5).find(x => x.id === 'addon-discovery');
    assert.ok(guide);
    assert.match(guide.summary, /addons_search\/addons_get/);
    assert.match(guide.summary, /Incoming webhook handling remains application logic/);
    assert.match(guide.summary, /Do not reinstall/);
  });
}

test('workflow discovery explains native alternatives and bounded code exceptions', () => {
  const guide = searchCatalog(docsIndex, 'native blocks filters custom code', 5).find(x => x.id === 'native-blocks-first');
  assert.ok(guide);
  assert.match(guide.summary, /joins and aggregates/);
  assert.match(guide.summary, /External API Call/);
  assert.match(guide.summary, /reproducible validation error/);
  assert.match(guide.summary, /never move an entire workflow into code/);
});
