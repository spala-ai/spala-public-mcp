import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

const BASE_ENV = {
  PORT: '4100',
  PUBLIC_BASE_URL: 'https://mcp.spala.ai',
  SPALA_API_BASE_URL: 'https://api.spala.ai',
  PUBLIC_OAUTH_ENCRYPTION_SECRET: 'test-public-oauth-encryption-secret-32-bytes',
  PUBLIC_OAUTH_REPLAY_STATE_PATH: '/tmp/mcp-spala-ai-config-test-replay',
  SPALA_DASHBOARD_URL: 'https://dashboard.spala.ai',
  SPALA_PRICING_URL: 'https://spala.ai/pricing/',
  SPALA_DOCS_URL: 'https://docs.spala.ai/agents/mcp',
  CORS_ALLOWED_ORIGINS: 'https://app.spala.ai,https://client.example',
  FETCH_TIMEOUT_MS: '2500',
  SPALA_API_RESPONSE_LIMIT_BYTES: '32768',
  PUBLIC_OAUTH_TICKET_LIFETIME_SECONDS: '300',
  PUBLIC_OAUTH_RATE_LIMIT_MAX: '180',
  MCP_BODY_LIMIT_BYTES: '65536',
  MCP_RATE_LIMIT_MAX: '240',
};

test('loadConfig parses strict valid configuration', () => {
  const config = loadConfig(BASE_ENV);
  assert.equal(config.port, 4100);
  assert.deepEqual(config.corsAllowedOrigins, ['https://app.spala.ai', 'https://client.example']);
  assert.equal(config.fetchTimeoutMs, 2500);
  assert.equal(config.publicOAuthEncryptionSecret, 'test-public-oauth-encryption-secret-32-bytes');
  assert.equal(config.publicOAuthReplayStatePath, '/tmp/mcp-spala-ai-config-test-replay');
  assert.equal(config.publicOAuthTicketLifetimeSeconds, 300);
  assert.equal(config.publicOAuthRateLimitMax, 180);
  assert.equal(config.spalaApiResponseLimitBytes, 32768);
  assert.equal(config.mcpBodyLimitBytes, 65536);
  assert.equal(config.mcpRateLimitMax, 240);
  assert.equal(config.pricingUrl, 'https://spala.ai/pricing');
});

test('loadConfig accepts hosted Unix socket listen targets', () => {
  const config = loadConfig({ ...BASE_ENV, PORT: '/tmp/spala-public-mcp.sock' });
  assert.equal(config.port, '/tmp/spala-public-mcp.sock');
});

test('loadConfig rejects malformed and unsafe configuration', () => {
  const invalid: Array<[string, Record<string, string>]> = [
    ['port', { PORT: '4100x' }],
    ['timeout', { FETCH_TIMEOUT_MS: '0' }],
    ['API response limit', { SPALA_API_RESPONSE_LIMIT_BYTES: '100' }],
    ['ticket lifetime', { PUBLIC_OAUTH_TICKET_LIFETIME_SECONDS: '10' }],
    ['body limit', { MCP_BODY_LIMIT_BYTES: '100' }],
    ['rate limit', { MCP_RATE_LIMIT_MAX: '0' }],
    ['OAuth rate limit', { PUBLIC_OAUTH_RATE_LIMIT_MAX: '0' }],
    ['public URL credentials', { PUBLIC_BASE_URL: 'https://user:pass@mcp.spala.ai' }],
    ['API URL path', { SPALA_API_BASE_URL: 'https://api.spala.ai/private' }],
    ['insecure API origin', { SPALA_API_BASE_URL: 'http://localhost:4101' }],
    ['31-byte OAuth secret', { PUBLIC_OAUTH_ENCRYPTION_SECRET: 'x'.repeat(31) }],
    ['OAuth secret line break', { PUBLIC_OAUTH_ENCRYPTION_SECRET: 'secret\nleak' }],
    ['relative OAuth replay path', { PUBLIC_OAUTH_REPLAY_STATE_PATH: '.state/oauth-replay' }],
    ['root OAuth replay path', { PUBLIC_OAUTH_REPLAY_STATE_PATH: '/tmp/..' }],
    ['OAuth replay path line break', { PUBLIC_OAUTH_REPLAY_STATE_PATH: '/tmp/oauth\nreplay' }],
    ['CORS wildcard', { CORS_ALLOWED_ORIGINS: '*' }],
    ['CORS path', { CORS_ALLOWED_ORIGINS: 'https://app.spala.ai/path' }],
    ['insecure remote CORS', { CORS_ALLOWED_ORIGINS: 'http://app.spala.ai' }],
  ];

  for (const [label, override] of invalid) {
    assert.throws(() => loadConfig({ ...BASE_ENV, ...override }), undefined, label);
  }
});

test('hosted configuration requires OAuth encryption and durable replay state', () => {
  assert.throws(() => loadConfig({ ...BASE_ENV, PUBLIC_OAUTH_ENCRYPTION_SECRET: '' }), /PUBLIC_OAUTH_ENCRYPTION_SECRET/);
  assert.throws(() => loadConfig({ ...BASE_ENV, PUBLIC_OAUTH_REPLAY_STATE_PATH: '' }), /PUBLIC_OAUTH_REPLAY_STATE_PATH/);

  const local = loadConfig({ PUBLIC_BASE_URL: 'http://localhost:4100' });
  assert.equal(local.publicOAuthEncryptionSecret, '');
  assert.match(local.publicOAuthReplayStatePath, /^\//);
});
