import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { author?: string };
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

test('public repository metadata uses Spala AI authorship', () => {
  assert.equal(packageJson.author, 'Spala AI <info@spala.ai>');
});

test('human README commands follow npm latest while generated plans stay pinned', () => {
  assert.match(readme, /npx --yes @spala-ai\/mcp-install init --client codex --yes --json/);
  assert.doesNotMatch(readme, /@spala-ai\/mcp-install@\d+\.\d+\.\d+/);
});
