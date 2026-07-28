import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import {
  createPublicMcpPlatformClient,
  PublicMcpPlatformError,
} from '../src/publicMcpPlatform.js';
import {
  PUBLIC_MCP_PLATFORM_ROUTES,
  PUBLIC_MCP_RESOURCE,
  PUBLIC_MCP_SERVICE_AUTH_HEADER,
  PUBLIC_MCP_SCOPE,
} from '../src/publicMcpContract.js';

const serviceSecret = 'public-mcp-platform-service-secret-for-tests';
const clientHash = 'a'.repeat(64);
const config = loadConfig({
  PUBLIC_BASE_URL: 'https://mcp.spala.ai',
  SPALA_API_BASE_URL: 'https://platform-api.example',
  PUBLIC_OAUTH_ENCRYPTION_SECRET: 'public-mcp-platform-oauth-secret-for-tests',
  PUBLIC_OAUTH_REPLAY_STATE_PATH: '/tmp/public-mcp-platform-test-replay',
  PUBLIC_MCP_PLATFORM_SERVICE_SECRET: serviceSecret,
});

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

test('cross-repository platform route and scope contract remains explicit', () => {
  assert.equal(PUBLIC_MCP_SCOPE, 'api');
  assert.equal(PUBLIC_MCP_SERVICE_AUTH_HEADER, 'x-spala-public-mcp-service-secret');
  assert.equal(PUBLIC_MCP_PLATFORM_ROUTES.approvalConsume, '/api/__internal/public-mcp/v1/approvals/consume');
  assert.equal(PUBLIC_MCP_PLATFORM_ROUTES.tokenIssue, '/api/__internal/public-mcp/v1/token');
  assert.equal(PUBLIC_MCP_PLATFORM_ROUTES.tokenRefresh, '/api/__internal/public-mcp/v1/token/refresh');
  assert.equal(PUBLIC_MCP_PLATFORM_ROUTES.tokenRevoke, '/api/__internal/public-mcp/v1/token/revoke');
  assert.equal(PUBLIC_MCP_PLATFORM_ROUTES.principal, '/api/__internal/public-mcp/v1/principal');
  assert.equal(PUBLIC_MCP_PLATFORM_ROUTES.users, '/api/__internal/public-mcp/v1/users');
  assert.equal(PUBLIC_MCP_PLATFORM_ROUTES.organizations, '/api/__internal/public-mcp/v1/organizations');
  assert.equal(PUBLIC_MCP_PLATFORM_ROUTES.projects, '/api/__internal/public-mcp/v1/projects');
  assert.equal(
    PUBLIC_MCP_PLATFORM_ROUTES.projectHandoff('project one'),
    '/api/__internal/public-mcp/v1/projects/project%20one/mcp-handoff',
  );
  assert.equal(
    PUBLIC_MCP_PLATFORM_ROUTES.projectAccessUrl('project one'),
    '/api/__internal/public-mcp/v1/projects/project%20one/access-url',
  );
});

test('platform OAuth adapter uses only fixed service-authenticated routes and typed bodies', async () => {
  const calls: Array<{ url: URL; init: RequestInit; body: Record<string, unknown> }> = [];
  let tokenSequence = 0;
  const client = createPublicMcpPlatformClient(config, (async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, init, body });
    if (url.pathname === PUBLIC_MCP_PLATFORM_ROUTES.approvalConsume) {
      return json({ grantCode: 'platform-grant-code-opaque-value', expiresIn: 300 });
    }
    if (url.pathname === PUBLIC_MCP_PLATFORM_ROUTES.tokenIssue || url.pathname === PUBLIC_MCP_PLATFORM_ROUTES.tokenRefresh) {
      tokenSequence += 1;
      const accessExpiresAt = new Date(Date.now() + 900_000).toISOString();
      return json({
        access_token: `opaque-access-token-${tokenSequence}-value`,
        refresh_token: `opaque-refresh-token-${tokenSequence}-value`,
        expires_in: 900,
        access_expires_at: accessExpiresAt,
        token_type: 'Bearer',
        resource: PUBLIC_MCP_RESOURCE,
        audience: PUBLIC_MCP_RESOURCE,
        scope: PUBLIC_MCP_SCOPE,
      });
    }
    if (url.pathname === PUBLIC_MCP_PLATFORM_ROUTES.tokenRevoke) return new Response(null, { status: 204 });
    return json({ error: 'unexpected_path' }, 404);
  }) as typeof fetch);

  const approval = await client.consumeApproval({
    request: 'v1.encrypted-local-request-value',
    approvalProof: 'opaque-approval-proof-value',
    clientHash,
  });
  const issued = await client.issueTokens({
    grantCode: approval.grantCode,
    clientHash,
  });
  assert.equal(approval.expiresIn, 300);
  const refreshed = await client.refreshTokens({
    refreshToken: issued.refreshToken,
    clientHash,
  });
  await client.revokeToken({
    token: refreshed.refreshToken,
    clientHash,
  });

  assert.notEqual(refreshed.refreshToken, issued.refreshToken);
  assert.ok(refreshed.accessExpiresAt > Math.floor(Date.now() / 1_000));
  assert.deepEqual(calls.map(call => call.url.pathname), [
    PUBLIC_MCP_PLATFORM_ROUTES.approvalConsume,
    PUBLIC_MCP_PLATFORM_ROUTES.tokenIssue,
    PUBLIC_MCP_PLATFORM_ROUTES.tokenRefresh,
    PUBLIC_MCP_PLATFORM_ROUTES.tokenRevoke,
  ]);
  for (const call of calls) {
    assert.equal(call.url.origin, 'https://platform-api.example');
    assert.equal(new Headers(call.init.headers).get(PUBLIC_MCP_SERVICE_AUTH_HEADER), serviceSecret);
    assert.equal(new Headers(call.init.headers).get('authorization'), null);
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.cache, 'no-store');
    assert.doesNotMatch(call.url.toString(), new RegExp(serviceSecret));
    assert.doesNotMatch(JSON.stringify(call.body), new RegExp(serviceSecret));
  }
  assert.deepEqual(calls[0]!.body, {
    approvalProof: 'opaque-approval-proof-value',
    requestHash: createHash('sha256').update('v1.encrypted-local-request-value').digest('hex'),
    clientHash,
    resource: PUBLIC_MCP_RESOURCE,
    scope: PUBLIC_MCP_SCOPE,
  });
  assert.deepEqual(calls[1]!.body, {
    grantCode: 'platform-grant-code-opaque-value',
    clientHash,
    resource: PUBLIC_MCP_RESOURCE,
    scope: PUBLIC_MCP_SCOPE,
  });
  assert.deepEqual(calls[2]!.body, {
    refreshToken: issued.refreshToken,
    clientHash,
    resource: PUBLIC_MCP_RESOURCE,
    scope: PUBLIC_MCP_SCOPE,
  });
  assert.deepEqual(calls[3]!.body, {
    token: refreshed.refreshToken,
    clientHash,
    resource: PUBLIC_MCP_RESOURCE,
  });
});

test('platform OAuth adapter classifies retryable and invalid grants without leaking credentials', async () => {
  const refreshToken = 'opaque-refresh-token-sensitive-value';
  const sensitiveClientHash = 'b'.repeat(64);
  const unavailable = createPublicMcpPlatformClient(config, (async () => {
    throw new Error(`${serviceSecret} ${refreshToken}`);
  }) as typeof fetch);
  await assert.rejects(
    unavailable.refreshTokens({ refreshToken, clientHash: sensitiveClientHash }),
    (error: unknown) => (
      error instanceof PublicMcpPlatformError
      && error.category === 'upstream_unavailable'
      && !error.message.includes(serviceSecret)
      && !error.message.includes(refreshToken)
    ),
  );

  const invalid = createPublicMcpPlatformClient(config, (async () => json({
    error: { code: refreshToken, message: `${serviceSecret} ${refreshToken}` },
  }, 400)) as typeof fetch);
  await assert.rejects(
    invalid.refreshTokens({ refreshToken, clientHash: sensitiveClientHash }),
    (error: unknown) => (
      error instanceof PublicMcpPlatformError
      && error.category === 'invalid_grant'
      && error.code === undefined
      && !error.message.includes(serviceSecret)
      && !error.message.includes(refreshToken)
    ),
  );
});
