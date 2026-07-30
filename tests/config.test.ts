import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

const BASE_ENV = {
  PORT: '4100',
  PUBLIC_BASE_URL: 'https://mcp.spala.ai',
  SPALA_API_BASE_URL: 'https://api.spala.ai',
  PUBLIC_OAUTH_ENCRYPTION_SECRET: 'test-public-oauth-encryption-secret-32-bytes',
  PUBLIC_MCP_PLATFORM_SERVICE_SECRET: 'test-public-mcp-platform-service-secret-32-bytes',
  PUBLIC_OAUTH_REPLAY_STATE_PATH: '/tmp/mcp-spala-ai-config-test-replay',
  SPALA_DASHBOARD_URL: 'https://dashboard.spala.ai',
  SPALA_PRICING_URL: 'https://spala.ai/pricing/',
  SPALA_DOCS_URL: 'https://docs.spala.ai/agents/mcp',
  CORS_ALLOWED_ORIGINS: 'https://app.spala.ai,https://client.example',
  PUBLIC_MCP_PLATFORM_TIMEOUT_MS: '2500',
  PUBLIC_MCP_PLATFORM_RESPONSE_LIMIT_BYTES: '32768',
  PUBLIC_MCP_TRUSTED_SHARED_RUNTIME_ORIGINS: 'https://runtime.spala.ai,https://runtime-2.spala.ai,https://runtime.spala.ai',
  SPALA_AGENT_A2A_RESOURCE_URL: 'https://agent.spala.ai/a2a/jsonrpc',
  PUBLIC_OAUTH_BODY_LIMIT_BYTES: '8192',
  PUBLIC_OAUTH_TICKET_LIFETIME_SECONDS: '300',
  PUBLIC_OAUTH_RATE_LIMIT_MAX: '180',
  MCP_BODY_LIMIT_BYTES: '65536',
  MCP_RATE_LIMIT_MAX: '240',
};

test('loadConfig parses strict valid configuration', () => {
  const config = loadConfig(BASE_ENV);
  assert.equal(config.port, 4100);
  assert.equal(config.spalaApiBaseUrl, 'https://api.spala.ai');
  assert.deepEqual(config.corsAllowedOrigins, ['https://app.spala.ai', 'https://client.example']);
  assert.equal(config.publicOAuthEncryptionSecret, 'test-public-oauth-encryption-secret-32-bytes');
  assert.equal(config.publicOAuthReplayStatePath, '/tmp/mcp-spala-ai-config-test-replay');
  assert.equal(config.publicOAuthTicketLifetimeSeconds, 300);
  assert.equal(config.publicOAuthRateLimitMax, 180);
  assert.equal(config.publicOAuthBodyLimitBytes, 8192);
  assert.equal(config.publicMcpPlatformServiceSecret, 'test-public-mcp-platform-service-secret-32-bytes');
  assert.equal(config.publicMcpPlatformTimeoutMs, 2500);
  assert.equal(config.publicMcpPlatformResponseLimitBytes, 32768);
  assert.deepEqual(config.publicMcpTrustedSharedRuntimeOrigins, [
    'https://runtime.spala.ai',
    'https://runtime-2.spala.ai',
  ]);
  assert.equal(config.spalaAgentA2aResourceUrl, 'https://agent.spala.ai/a2a/jsonrpc');
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
    ['timeout', { PUBLIC_MCP_PLATFORM_TIMEOUT_MS: '0' }],
    ['API response limit', { PUBLIC_MCP_PLATFORM_RESPONSE_LIMIT_BYTES: '100' }],
    ['OAuth body limit', { PUBLIC_OAUTH_BODY_LIMIT_BYTES: '100' }],
    ['ticket lifetime', { PUBLIC_OAUTH_TICKET_LIFETIME_SECONDS: '10' }],
    ['body limit', { MCP_BODY_LIMIT_BYTES: '100' }],
    ['rate limit', { MCP_RATE_LIMIT_MAX: '0' }],
    ['OAuth rate limit', { PUBLIC_OAUTH_RATE_LIMIT_MAX: '0' }],
    ['trusted runtime wildcard', { PUBLIC_MCP_TRUSTED_SHARED_RUNTIME_ORIGINS: '*' }],
    ['trusted runtime path', { PUBLIC_MCP_TRUSTED_SHARED_RUNTIME_ORIGINS: 'https://runtime.spala.ai/project' }],
    ['trusted runtime query', { PUBLIC_MCP_TRUSTED_SHARED_RUNTIME_ORIGINS: 'https://runtime.spala.ai?project=one' }],
    ['trusted runtime credentials', { PUBLIC_MCP_TRUSTED_SHARED_RUNTIME_ORIGINS: 'https://user:pass@runtime.spala.ai' }],
    ['insecure trusted runtime', { PUBLIC_MCP_TRUSTED_SHARED_RUNTIME_ORIGINS: 'http://runtime.spala.ai' }],
    ['public URL credentials', { PUBLIC_BASE_URL: 'https://user:pass@mcp.spala.ai' }],
    ['API URL path', { SPALA_API_BASE_URL: 'https://api.spala.ai/private' }],
    ['insecure API origin', { SPALA_API_BASE_URL: 'http://api.spala.example' }],
    ['A2A resource wrong path', { SPALA_AGENT_A2A_RESOURCE_URL: 'https://agent.spala.ai/mcp' }],
    ['A2A resource query', { SPALA_AGENT_A2A_RESOURCE_URL: 'https://agent.spala.ai/a2a/jsonrpc?scope=api' }],
    ['31-byte OAuth secret', { PUBLIC_OAUTH_ENCRYPTION_SECRET: 'x'.repeat(31) }],
    ['OAuth secret line break', { PUBLIC_OAUTH_ENCRYPTION_SECRET: 'secret\nleak' }],
    ['31-byte service secret', { PUBLIC_MCP_PLATFORM_SERVICE_SECRET: 'x'.repeat(31) }],
    ['service secret whitespace', { PUBLIC_MCP_PLATFORM_SERVICE_SECRET: `service-secret-${'x'.repeat(32)}\n` }],
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

test('configuration fails closed without an explicit platform origin and service secrets', () => {
  assert.throws(() => loadConfig({ ...BASE_ENV, SPALA_API_BASE_URL: '' }), /SPALA_API_BASE_URL/);
  assert.throws(() => loadConfig({ ...BASE_ENV, PUBLIC_OAUTH_ENCRYPTION_SECRET: '' }), /PUBLIC_OAUTH_ENCRYPTION_SECRET/);
  assert.throws(() => loadConfig({ ...BASE_ENV, PUBLIC_MCP_PLATFORM_SERVICE_SECRET: '' }), /PUBLIC_MCP_PLATFORM_SERVICE_SECRET/);
  assert.throws(() => loadConfig({ ...BASE_ENV, PUBLIC_OAUTH_REPLAY_STATE_PATH: '' }), /PUBLIC_OAUTH_REPLAY_STATE_PATH/);

  const local = loadConfig({
    PUBLIC_BASE_URL: 'http://localhost:4100',
    SPALA_API_BASE_URL: 'http://127.0.0.1:3000',
    PUBLIC_OAUTH_ENCRYPTION_SECRET: 'local-public-oauth-encryption-secret-32-bytes',
    PUBLIC_MCP_PLATFORM_SERVICE_SECRET: 'local-platform-service-secret-value-32-bytes',
  });
  assert.equal(local.spalaApiBaseUrl, 'http://127.0.0.1:3000');
  assert.deepEqual(local.publicMcpTrustedSharedRuntimeOrigins, []);
  assert.match(local.publicOAuthReplayStatePath, /^\//);
});

test('runtime source contains no hardcoded production platform API origin', () => {
  const source = readFileSync(resolve('src/config.ts'), 'utf8');
  assert.doesNotMatch(source, /https:\/\/api\.spala\.ai/);
});
