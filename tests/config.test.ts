import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

const BASE_ENV = {
  PORT: '4100',
  PUBLIC_BASE_URL: 'https://mcp.spala.ai',
  SPALA_API_BASE_URL: 'https://api.spala.ai',
  SPALA_DASHBOARD_URL: 'https://dashboard.spala.ai',
  SPALA_DOCS_URL: 'https://docs.spala.ai/agents/mcp',
  CORS_ALLOWED_ORIGINS: 'https://app.spala.ai,https://client.example',
  FETCH_TIMEOUT_MS: '2500',
  MCP_BODY_LIMIT_BYTES: '65536',
  MCP_RATE_LIMIT_MAX: '240',
  DRY_RUN_PROJECT_CREATE: 'true',
};

test('loadConfig parses strict valid configuration', () => {
  const config = loadConfig(BASE_ENV);
  assert.equal(config.port, 4100);
  assert.deepEqual(config.corsAllowedOrigins, ['https://app.spala.ai', 'https://client.example']);
  assert.equal(config.fetchTimeoutMs, 2500);
  assert.equal(config.mcpBodyLimitBytes, 65536);
  assert.equal(config.mcpRateLimitMax, 240);
  assert.equal(config.dryRunProjectCreate, true);
});

test('loadConfig rejects malformed and unsafe configuration', () => {
  const invalid: Array<[string, Record<string, string>]> = [
    ['boolean', { DRY_RUN_PROJECT_CREATE: 'yes' }],
    ['real project writes', { DRY_RUN_PROJECT_CREATE: 'false' }],
    ['port', { PORT: '4100x' }],
    ['timeout', { FETCH_TIMEOUT_MS: '0' }],
    ['body limit', { MCP_BODY_LIMIT_BYTES: '100' }],
    ['rate limit', { MCP_RATE_LIMIT_MAX: '0' }],
    ['public URL credentials', { PUBLIC_BASE_URL: 'https://user:pass@mcp.spala.ai' }],
    ['API URL path', { SPALA_API_BASE_URL: 'https://api.spala.ai/private' }],
    ['CORS wildcard', { CORS_ALLOWED_ORIGINS: '*' }],
    ['CORS path', { CORS_ALLOWED_ORIGINS: 'https://app.spala.ai/path' }],
    ['insecure remote CORS', { CORS_ALLOWED_ORIGINS: 'http://app.spala.ai' }],
  ];

  for (const [label, override] of invalid) {
    assert.throws(() => loadConfig({ ...BASE_ENV, ...override }), undefined, label);
  }
});
