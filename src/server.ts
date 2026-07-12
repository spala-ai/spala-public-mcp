import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createSpalaPublicMcpServer, projectToolCapabilities, PUBLIC_TOOL_CAPABILITIES } from './mcp.js';
import { createSpalaApiClient } from './spalaApi.js';

const config = loadConfig();
const api = createSpalaApiClient(config);
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

const MCP_RATE_LIMIT_WINDOW_MS = 60_000;
const mcpRateBuckets = new Map<string, { count: number; resetAt: number }>();

function isSafeCorsOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const localHttp = url.protocol === 'http:'
    && ['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase());
  return origin === url.origin && (url.protocol === 'https:' || localHttp);
}

app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && !isSafeCorsOrigin(origin)) {
    res.status(403).json({ error: 'origin_not_allowed' });
    return;
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.appendHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept,Mcp-Protocol-Version,Mcp-Session-Id,Last-Event-ID');
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate,Mcp-Protocol-Version,Mcp-Session-Id');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use('/mcp', mcpRateLimit);
app.use(express.json({ limit: config.mcpBodyLimitBytes, strict: false }));

const PUBLIC_TOOLS = ['spala_help', 'spala_get_onboarding', 'spala_get_tool_map', 'docs_search', 'template_list', 'addon_list'];
const AUTHENTICATED_TOOLS = ['project_list', 'project_create', 'project_select', 'project_get_mcp_manifest', 'project_get_public_context'];
const MCP_SCOPES = ['api'];
const ACCEPTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18'] as const;
const AGENT_START_URL = 'https://spala.ai/agents.md';
const MAINTAINER = {
  name: 'Spala AI',
  contact: 'vitali@spala.ai',
  website: 'https://spala.ai/',
};

const GLAMA_CONNECTOR_VERIFICATION = {
  $schema: 'https://glama.ai/mcp/schemas/connector.json',
  maintainers: [{ email: 'paul@spala.ai' }],
};

const PROTOCOL_COMPATIBILITY = {
  transport: 'streamable-http',
  sdk: '@modelcontextprotocol/sdk',
  sdkPackageRange: '^1.27.1',
  specReference: 'https://modelcontextprotocol.io/specification',
  acceptedProtocolVersions: ACCEPTED_PROTOCOL_VERSIONS,
  minimumProtocolVersion: '2025-06-18',
  initializeBehavior: 'MCP protocol version is negotiated during initialize. This standalone release accepts only 2025-06-18 or newer supported protocol revisions and rejects older initialize protocolVersion values.',
  rawHttpHeaders: {
    contentType: 'application/json',
    accept: 'application/json, text/event-stream',
  },
};

const PROJECT_HANDOFF_EXAMPLE = {
  projectId: 'proj_xxx',
  name: 'Example Project',
  mcpUrl: 'https://returned-by-spala.example/mcp',
  transport: 'streamable-http',
  note: 'Example only for a future authenticated platform handoff. This standalone release cannot return project MCP URLs.',
};
const PUBLIC_MCP_SERVER_NAME = 'spala_public_mcp';
const PROJECT_HANDOFF_STATUS = {
  available: false,
  code: 'project_handoff_unavailable',
  authValidation: 'unavailable',
  reason: 'Project handoff is not enabled in this standalone public MCP release.',
};
const PROJECT_AUTH_FAILURE_HINT = 'Missing bearer returns HTTP 401 OAuth metadata; supplied bearer returns HTTP 503 project_handoff_unavailable because project handoff is not enabled in this standalone release.';

function allToolCapabilities() {
  return [...PUBLIC_TOOL_CAPABILITIES, ...projectToolCapabilities(config)];
}

function publicMcpUrl(): string {
  return `${config.publicBaseUrl}/mcp`;
}

function protectedResourceMetadataUrl(): string {
  return `${config.publicBaseUrl}/.well-known/oauth-protected-resource/mcp`;
}

function platformAuthServerUrl(): string {
  return `${config.spalaApiBaseUrl}/mcp`;
}

function canonicalAuthorizationServerMetadataUrl(): string {
  return `${config.spalaApiBaseUrl}/.well-known/oauth-authorization-server/mcp`;
}

function canonicalOpenIdMetadataUrl(): string {
  return `${config.spalaApiBaseUrl}/.well-known/openid-configuration/mcp`;
}

function authServerOnlyNote(): string {
  return 'api.spala.ai/mcp is the canonical Spala OAuth authorization server issuer, not the public MCP URL clients should configure. Token validation, project lookup, project selection, and project MCP URL handoff are unavailable in this standalone release.';
}

function protectedResourceMetadata() {
  return {
    resource: publicMcpUrl(),
    authorization_servers: [platformAuthServerUrl()],
    bearer_methods_supported: ['header'],
    scopes_supported: MCP_SCOPES,
    resource_documentation: config.docsUrl,
    agent_start_url: AGENT_START_URL,
    maintainer: MAINTAINER,
    note: authServerOnlyNote(),
  };
}

function authChallengeData() {
  const authorizationServer = platformAuthServerUrl();
  return {
    error: 'authentication_required',
    message: 'Authenticate with Spala platform/dashboard OAuth before using project tools.',
    protectedResourceMetadata: protectedResourceMetadataUrl(),
    authorizationServerMetadata: canonicalAuthorizationServerMetadataUrl(),
    authorizationServer,
    authorizationServerOnlyNote: authServerOnlyNote(),
    authorizationEndpoint: `${authorizationServer}/oauth/authorize`,
    tokenEndpoint: `${authorizationServer}/oauth/token`,
    deviceAuthorizationEndpoint: `${authorizationServer}/oauth/device_authorization`,
    registrationEndpoint: `${authorizationServer}/oauth/register`,
    dashboardUrl: config.dashboardUrl,
    agentStartUrl: AGENT_START_URL,
    expectedAuthorization: 'Authorization: Bearer <access token issued for this MCP resource>',
    scope: 'api',
    projectHandoffStatus: 'project_handoff_unavailable',
  };
}

function discoveryLinks() {
  return {
    agentStart: AGENT_START_URL,
    rootAgentJson: 'https://spala.ai/.well-known/agent.json',
    rootMcpJson: 'https://spala.ai/.well-known/mcp.json',
    rootLlmsTxt: 'https://spala.ai/llms.txt',
    publicMcp: publicMcpUrl(),
    mcpProfile: config.docsUrl,
    npmInstaller: 'https://www.npmjs.com/package/@spala-ai/mcp-install',
    installManifest: `${config.publicBaseUrl}/mcp/install-manifest`,
    oauthProtectedResource: protectedResourceMetadataUrl(),
    oauthAuthorizationServer: canonicalAuthorizationServerMetadataUrl(),
    dashboard: config.dashboardUrl,
    docs: config.docsUrl,
    security: 'https://spala.ai/security/',
    limits: 'https://spala.ai/limits/',
    launchKit: 'https://spala.ai/launch-kit/',
    productHuntKit: 'https://spala.ai/product-hunt-kit/',
    projectMcpTest: `${config.publicBaseUrl}/.well-known/project-mcp-test.json`,
    projectMcpTestMarkdown: `${config.publicBaseUrl}/.well-known/project-mcp-test.md`,
    smitheryServerCard: `${config.publicBaseUrl}/.well-known/mcp/server-card.json`,
    brand: 'https://spala.ai/brand/',
  };
}

function projectMcpTestTemplate() {
  return {
    schemaVersion: 1,
    name: 'Spala Project MCP Handoff Test Template',
    status: 'project_handoff_unavailable',
    boundary: 'This is a public-safe test template, not proof of a completed OAuth handoff. It contains no tokens, private project IDs, private project URLs, customer data, source code, internal IPs, or private architecture.',
    canonicalPublicMcp: publicMcpUrl(),
    agentRule: 'This standalone release cannot return project MCP URLs. Do not infer, append, or hardcode project MCP URLs.',
    auth: {
      protectedResourceMetadata: protectedResourceMetadataUrl(),
      authorizationServerMetadata: canonicalAuthorizationServerMetadataUrl(),
      authorizationServer: platformAuthServerUrl(),
      expectedAuthorizationHeader: 'Authorization: Bearer <access token issued for this MCP resource>',
      scope: 'api',
      authFailureBehavior: 'Missing bearer credentials return HTTP 401 with OAuth metadata. Supplied bearer credentials return HTTP 503 project_handoff_unavailable until project handoff is enabled.',
    },
    requiredFlow: [
      {
        step: 1,
        call: `POST ${publicMcpUrl()} initialize`,
        expected: 'Public MCP initializes with streamable HTTP.',
        redact: ['client session IDs', 'debug headers'],
      },
      {
        step: 2,
        call: 'tools/list',
        expected: 'Public discovery tools and auth-gated project handoff tools are visible. Auth-gated tools are marked requiresAuth in tool metadata.',
        redact: ['client trace IDs'],
      },
      {
        step: 3,
        call: 'project_list without Authorization',
        expected: 'HTTP 401 with WWW-Authenticate and OAuth metadata.',
        redact: ['none expected'],
      },
      {
        step: 4,
        call: 'Complete Spala platform OAuth outside transcript',
        expected: 'Client obtains a platform access token.',
        redact: ['authorization codes', 'access tokens', 'refresh tokens', 'cookies', 'emails', 'account IDs'],
      },
      {
        step: 5,
        call: 'project_list with Authorization',
        expected: 'Fails closed before MCP tool processing with HTTP 503 project_handoff_unavailable until project handoff is enabled for the public MCP.',
        redact: ['project IDs', 'project names unless demo-approved', 'organization IDs', 'owner emails'],
      },
      {
        step: 6,
        call: 'project_select',
        expected: 'Unavailable in this standalone release. A future compatible contract must return an exact selected project mcpUrl before agents connect to a project MCP.',
        redact: ['private project IDs', 'private slugs', 'tenant identifiers', 'URL tokens'],
      },
      {
        step: 7,
        call: 'project_get_mcp_manifest',
        expected: 'Unavailable in this standalone release. A future compatible contract must return the exact mcpUrl and transport.',
        redact: ['private project URL if it contains private identifiers'],
      },
    ],
    toolCapabilities: allToolCapabilities(),
    projectCreate: {
      implemented: true,
      dryRunOnly: config.dryRunProjectCreate,
      effect: config.dryRunProjectCreate ? 'no-op' : 'write',
      note: config.dryRunProjectCreate
        ? 'project_create is dry-run only in this public MCP deployment and does not create a real project.'
        : 'project_create is enabled for authenticated users in this deployment.',
    },
    projectHandoffStatus: PROJECT_HANDOFF_STATUS,
    claimsToAvoid: [
      'Do not claim this template is proof of a completed authenticated handoff.',
      'Do not claim public MCP anonymously creates, mutates, validates, or publishes projects.',
      'Do not publish tokens, private project URLs, customer data, source code, internal IPs, or private architecture.',
    ],
  };
}

function projectMcpTestMarkdown(): string {
  const template = projectMcpTestTemplate();
  return `# Spala Project MCP Handoff Test Template

Status: ${template.status}

${template.boundary}

Agent rule: ${template.agentRule}

## OAuth

- Protected resource metadata: ${template.auth.protectedResourceMetadata}
- Authorization server metadata: ${template.auth.authorizationServerMetadata}
- Authorization server: ${template.auth.authorizationServer}
- Expected header: ${template.auth.expectedAuthorizationHeader}
- Auth failure behavior: ${template.auth.authFailureBehavior}

## Required flow

${template.requiredFlow.map(item => `${item.step}. ${item.call}\n   Expected: ${item.expected}\n   Redact: ${item.redact.join(', ')}`).join('\n\n')}

## project_create

- Implemented: ${template.projectCreate.implemented}
- Dry-run only: ${template.projectCreate.dryRunOnly}
- Effect: ${template.projectCreate.effect}
- Note: ${template.projectCreate.note}

Machine-readable JSON: ${config.publicBaseUrl}/.well-known/project-mcp-test.json
`;
}

function smitheryServerCard() {
  const tools = allToolCapabilities().map(tool => ({
    name: tool.name,
    description: tool.purpose,
    requiresAuth: tool.requiresAuth,
    effect: tool.effect,
  }));

  return {
    $schema: 'https://smithery.ai/schemas/server-card.json',
    schemaVersion: 1,
    name: 'Spala Public MCP',
    description: 'Discovery, canonical OAuth metadata, and a fail-closed project MCP handoff interface for Spala backend projects.',
    url: publicMcpUrl(),
    transport: 'streamable-http',
    homepage: config.docsUrl,
    documentation: config.docsUrl,
    protocolCompatibility: PROTOCOL_COMPATIBILITY,
    maintainer: MAINTAINER,
    authentication: {
      publicTools: 'anonymous',
      projectTools: 'spala_platform_oauth',
      protectedResourceMetadata: protectedResourceMetadataUrl(),
      authorizationServerMetadata: canonicalAuthorizationServerMetadataUrl(),
      authorizationServer: platformAuthServerUrl(),
      note: authServerOnlyNote(),
    },
    capabilities: {
      publicTools: PUBLIC_TOOLS,
      authenticatedTools: AUTHENTICATED_TOOLS,
      tools,
    },
    boundaries: {
      publicMcp: 'Discovery, docs, template/addon lookup, OAuth metadata, and a fail-closed project MCP handoff interface.',
      projectMcp: 'Build, validate, publish, and operate one selected Spala backend project.',
      projectMcpResolution: 'Unavailable in this standalone release. A future compatible contract must return an exact mcpUrl; do not derive project MCP URLs from project names, slugs, hosts, or api.spala.ai patterns.',
    },
    links: discoveryLinks(),
    sourceRepositoryUrl: 'not_applicable_private_source_not_public',
    publicSafety: {
      containsSecrets: false,
      containsPrivateProjectData: false,
      containsSourceCode: false,
      containsCustomerData: false,
    },
    projectHandoffStatus: PROJECT_HANDOFF_STATUS,
  };
}

function setDiscoveryCache(res: Response): void {
  res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
  res.setHeader('Last-Modified', new Date().toUTCString());
}

function sitemapXml(): string {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    config.publicBaseUrl,
    publicMcpUrl(),
    `${config.publicBaseUrl}/mcp/install-manifest`,
    `${config.publicBaseUrl}/.well-known/agent.json`,
    `${config.publicBaseUrl}/.well-known/mcp.json`,
    protectedResourceMetadataUrl(),
    `${config.publicBaseUrl}/.well-known/project-mcp-test.json`,
    `${config.publicBaseUrl}/.well-known/project-mcp-test.md`,
    `${config.publicBaseUrl}/.well-known/mcp/server-card.json`,
    `${config.publicBaseUrl}/robots.txt`,
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map(url => [
      '  <url>',
      `    <loc>${url}</loc>`,
      `    <lastmod>${today}</lastmod>`,
      '  </url>',
    ].join('\n')),
    '</urlset>',
    '',
  ].join('\n');
}

function authChallengeResponse(res: Response, id: unknown, message = 'Authentication required'): void {
  setWwwAuthenticate(res);
  res.status(401).json({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32001,
      message,
      data: authChallengeData(),
    },
  });
}

function agentMarkdown(): string {
  return `# Spala Public MCP

Spala Public MCP is the public agent entry point for Spala at ${publicMcpUrl()}.

Use it to discover Spala, read onboarding, search docs, inspect templates and addons, and inspect the fail-closed project tool interface.

## Boundary

- mcp.spala.ai is for discovery, auth metadata, and the project lookup/handoff interface.
- Project lookup, project selection, and project handoff are unavailable in this standalone release and fail closed until project handoff is enabled for the public MCP.
- A project MCP is for backend building and operation: models, endpoints, auth, backend logic, validation, publish, and project test review.
- Do not hardcode project MCP URLs.
- Do not hardcode, construct, append, or infer project MCP URLs. This standalone release does not return project MCP URLs.
- Canonical agent start URL: ${AGENT_START_URL}
- Public MCP docs: ${config.docsUrl}
- Security evaluation: https://spala.ai/security/

## Public Tools

${PUBLIC_TOOLS.map(tool => `- ${tool}`).join('\n')}

## Authenticated Tools

${AUTHENTICATED_TOOLS.map(tool => `- ${tool}`).join('\n')}

## OAuth

Protected resource metadata: ${protectedResourceMetadataUrl()}
Authorization server metadata: ${canonicalAuthorizationServerMetadataUrl()}
Authorization server: ${platformAuthServerUrl()}
Device authorization endpoint: ${platformAuthServerUrl()}/oauth/device_authorization

Project tools require scope api and Authorization: Bearer <access token issued for this MCP resource>.
`;
}

function llmsText(): string {
  return `# Spala Public MCP

> Public MCP server for Spala discovery, canonical OAuth metadata, and a fail-closed project MCP handoff interface.

MCP endpoint: ${publicMcpUrl()}
Install manifest: ${config.publicBaseUrl}/mcp/install-manifest
OAuth protected resource metadata: ${protectedResourceMetadataUrl()}
OAuth authorization server metadata: ${canonicalAuthorizationServerMetadataUrl()}
Dashboard: ${config.dashboardUrl}
Agent start: ${AGENT_START_URL}
Public MCP docs: ${config.docsUrl}

Core distinction: use public MCP for discovery and project handoff. Use project MCP for backend building.
Standalone-release boundary: project listing, project selection, and project MCP URL handoff are unavailable and fail closed.

Public tools: ${PUBLIC_TOOLS.join(', ')}
Authenticated tools: ${AUTHENTICATED_TOOLS.join(', ')}

Agent rule: do not hardcode, construct, append, or infer project MCP URLs. This standalone release cannot validate bearer tokens or return project MCP URLs.

Redacted handoff example:
${JSON.stringify(PROJECT_HANDOFF_EXAMPLE, null, 2)}
`;
}

function pricingMarkdown(): string {
  return `# Spala Pricing

Canonical pricing page: https://spala.ai/pricing

This MCP service does not define account billing. Use Spala public product pages and dashboard account state for current pricing, plan limits, and package availability.
`;
}

function setWwwAuthenticate(res: Response): void {
  res.setHeader(
    'WWW-Authenticate',
    `Bearer resource_metadata="${protectedResourceMetadataUrl()}", scope="api"`,
  );
}

function mcpRateLimit(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'POST') {
    next();
    return;
  }

  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  let bucket = mcpRateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + MCP_RATE_LIMIT_WINDOW_MS };
    mcpRateBuckets.set(key, bucket);
  }

  const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000));
  res.setHeader('RateLimit-Limit', String(config.mcpRateLimitMax));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, config.mcpRateLimitMax - bucket.count - 1)));
  res.setHeader('RateLimit-Reset', String(resetSeconds));

  if (bucket.count >= config.mcpRateLimitMax) {
    res.setHeader('Retry-After', String(resetSeconds));
    res.status(429).json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32000,
        message: 'Rate limit exceeded',
        data: { error: 'rate_limit_exceeded', retryAfterSeconds: resetSeconds },
      },
    });
    return;
  }

  bucket.count += 1;
  if (mcpRateBuckets.size > 10_000) {
    for (const [bucketKey, candidate] of mcpRateBuckets) {
      if (candidate.resetAt <= now) mcpRateBuckets.delete(bucketKey);
    }
    while (mcpRateBuckets.size > 10_000) {
      const oldestKey = mcpRateBuckets.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      mcpRateBuckets.delete(oldestKey);
    }
  }
  next();
}

function jsonRpcId(body: unknown): unknown {
  if (body && typeof body === 'object' && !Array.isArray(body) && 'id' in body) {
    const id = (body as { id?: unknown }).id;
    if (id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))) return id;
  }
  return null;
}

function hasJsonRpcId(body: unknown): boolean {
  return !!body && typeof body === 'object' && !Array.isArray(body) && 'id' in body;
}

function requestedToolName(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const request = body as { method?: unknown; params?: unknown };
  if (request.method !== 'tools/call') return null;
  const params = request.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const name = (params as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

function isProjectToolCall(body: unknown): boolean {
  const toolName = requestedToolName(body);
  return typeof toolName === 'string' && toolName.startsWith('project_');
}

function hasBearerCredential(req: Request): boolean {
  const value = req.get('authorization') || '';
  return value.length <= 8_192 && /^Bearer\s+\S/i.test(value);
}

function isValidJsonRpcRequest(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const request = body as Record<string, unknown>;
  if (request['jsonrpc'] !== '2.0' || typeof request['method'] !== 'string') return false;
  if ('params' in request) {
    const params = request['params'];
    if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  }
  if ('id' in request) {
    const id = request['id'];
    if (id !== null && typeof id !== 'string' && (typeof id !== 'number' || !Number.isFinite(id))) {
      return false;
    }
  }
  return true;
}

function jsonRpcErrorResponse(res: Response, status: number, code: number, message: string, id: unknown = null, data?: Record<string, unknown>): void {
  const error: { code: number; message: string; data?: Record<string, unknown> } = { code, message };
  if (data) error.data = data;
  res.status(status).json({
    jsonrpc: '2.0',
    id,
    error,
  });
}

function invalidRequestResponse(res: Response, id: unknown = null, status = 400, data?: Record<string, unknown>): void {
  jsonRpcErrorResponse(res, status, -32600, 'Invalid Request', id, data);
}

function authValidationUnavailableResponse(res: Response, id: unknown): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(503).json({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32002,
      message: 'Authentication validation unavailable',
      data: {
        error: 'project_handoff_unavailable',
        message: 'Project operations are disabled because project handoff is not enabled in this standalone public MCP release.',
      },
    },
  });
}

function jsonParseErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  const parseError = err instanceof SyntaxError || (err as { type?: unknown })?.type === 'entity.parse.failed';
  if (!parseError) {
    next(err);
    return;
  }

  if (req.path === '/mcp') {
    res.status(400).json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'Parse error',
        data: {
          error: 'invalid_json',
          message: 'Request body must be valid JSON-RPC JSON.',
        },
      },
    });
    return;
  }

  res.status(400).json({
    error: 'invalid_json',
    message: 'Request body must be valid JSON.',
  });
}

app.use(jsonParseErrorHandler);

app.use('/mcp', (req, res, next) => {
  if (req.method === 'POST' && !req.is('application/json')) {
    invalidRequestResponse(res, null, 415, {
      error: 'unsupported_media_type',
      message: 'MCP JSON-RPC requests must use Content-Type: application/json.',
    });
    return;
  }
  next();
});

app.use('/mcp', (req, res, next) => {
  const protocolVersion = req.get('mcp-protocol-version');
  if (protocolVersion && !ACCEPTED_PROTOCOL_VERSIONS.includes(protocolVersion as typeof ACCEPTED_PROTOCOL_VERSIONS[number])) {
    res.status(400).json({
      jsonrpc: '2.0',
      id: jsonRpcId(req.body),
      error: {
        code: -32000,
        message: 'Unsupported MCP protocol version',
        data: { supportedProtocolVersions: ACCEPTED_PROTOCOL_VERSIONS },
      },
    });
    return;
  }
  if (protocolVersion) res.setHeader('Mcp-Protocol-Version', protocolVersion);
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'mcp-spala-ai' });
});

app.get('/robots.txt', (_req, res) => {
  setDiscoveryCache(res);
  res.type('text/plain; charset=utf-8').send([
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${config.publicBaseUrl}/sitemap.xml`,
    '',
    '# Spala Public MCP is intended for agent discovery, OAuth metadata, and a fail-closed project tool interface.',
    '# Public discovery tools are anonymous. Project tools require Spala platform authorization.',
    '',
  ].join('\n'));
});

app.get('/sitemap.xml', (_req, res) => {
  setDiscoveryCache(res);
  res.type('application/xml; charset=utf-8').send(sitemapXml());
});

app.get('/', (_req, res) => {
  setDiscoveryCache(res);
  res.json({
    name: 'Spala Public MCP',
    purpose: 'Public agent front door for Spala discovery, platform auth metadata, and a fail-closed project tool interface.',
    canonicalMcpUrl: publicMcpUrl(),
    maintainer: MAINTAINER,
    protocolCompatibility: PROTOCOL_COMPATIBILITY,
    links: discoveryLinks(),
    endpoints: {
      mcp: publicMcpUrl(),
      health: `${config.publicBaseUrl}/health`,
      mcpJson: `${config.publicBaseUrl}/.well-known/mcp.json`,
      installManifest: `${config.publicBaseUrl}/mcp/install-manifest`,
      oauthProtectedResource: protectedResourceMetadataUrl(),
      oauthAuthorizationServer: canonicalAuthorizationServerMetadataUrl(),
    },
    auth: {
      type: 'spala_platform_auth',
      authorizationServer: platformAuthServerUrl(),
      dashboardUrl: config.dashboardUrl,
      note: 'Public discovery tools are unauthenticated. Project tools require Spala platform/dashboard auth.',
    },
    publicTools: PUBLIC_TOOLS,
    authenticatedTools: AUTHENTICATED_TOOLS,
    toolCapabilities: allToolCapabilities(),
    authRequiredTools: projectToolCapabilities(config).map(tool => tool.name),
    authFailureHint: PROJECT_AUTH_FAILURE_HINT,
    projectCreateCapability: projectToolCapabilities(config).find(tool => tool.name === 'project_create'),
    projectHandoffExample: PROJECT_HANDOFF_EXAMPLE,
    projectHandoffStatus: PROJECT_HANDOFF_STATUS,
  });
});

app.get('/agents.md', (_req, res) => {
  setDiscoveryCache(res);
  res.type('text/markdown; charset=utf-8').send(agentMarkdown());
});

app.get('/llms.txt', (_req, res) => {
  setDiscoveryCache(res);
  res.type('text/plain; charset=utf-8').send(llmsText());
});

app.get('/pricing.md', (_req, res) => {
  setDiscoveryCache(res);
  res.type('text/markdown; charset=utf-8').send(pricingMarkdown());
});

app.get('/.well-known/agent.json', (_req, res) => {
  setDiscoveryCache(res);
  res.json({
    name: 'Spala Public MCP',
    description: 'Public agent entry point for Spala discovery, OAuth handoff, project lookup, and project MCP routing.',
    mcp: {
      endpoint: publicMcpUrl(),
      transport: 'streamable-http',
      installManifest: `${config.publicBaseUrl}/mcp/install-manifest`,
      protocolCompatibility: PROTOCOL_COMPATIBILITY,
    },
    maintainer: MAINTAINER,
    oauth: {
      protectedResourceMetadata: protectedResourceMetadataUrl(),
      authorizationServerMetadata: canonicalAuthorizationServerMetadataUrl(),
      authorizationServer: platformAuthServerUrl(),
    },
    boundaries: {
      publicMcp: 'Discovery, docs, auth metadata, and a fail-closed project tool interface. Project lookup, project selection, and handoff are unavailable in this standalone release.',
      projectMcp: 'Backend build, validation, publishing, and operation for one project.',
      projectMcpResolution: 'Unavailable in this standalone release. A future compatible contract must return an exact mcpUrl; do not derive a URL from project names, slugs, hosts, or api.spala.ai patterns.',
    },
    publicTools: PUBLIC_TOOLS,
    authenticatedTools: AUTHENTICATED_TOOLS,
    toolCapabilities: allToolCapabilities(),
    authRequiredTools: projectToolCapabilities(config).map(tool => tool.name),
    authFailureHint: PROJECT_AUTH_FAILURE_HINT,
    projectCreateCapability: projectToolCapabilities(config).find(tool => tool.name === 'project_create'),
    links: discoveryLinks(),
    projectHandoffExample: PROJECT_HANDOFF_EXAMPLE,
    projectHandoffStatus: PROJECT_HANDOFF_STATUS,
  });
});

app.get('/.well-known/mcp.json', (_req, res) => {
  setDiscoveryCache(res);
  res.json({
    name: 'Spala Public MCP',
    url: publicMcpUrl(),
    transport: 'streamable-http',
    protocolCompatibility: PROTOCOL_COMPATIBILITY,
    maintainer: MAINTAINER,
    auth: 'spala_platform_auth',
    authNotes: 'Project tools require verified Spala platform authentication. Token validation is currently unavailable, so bearer credentials fail closed with HTTP 503 before tool processing.',
    docs: `${config.publicBaseUrl}/mcp/install-manifest`,
    agentStartUrl: AGENT_START_URL,
    role: {
      publicMcp: 'Discovery, docs, template/addon lookup, OAuth metadata, and a fail-closed project tool interface. Token validation, project lookup, project selection, and handoff are unavailable in this standalone release.',
      projectMcp: 'Build, validate, publish, and operate one selected Spala backend project.',
    },
    projectMcpResolution: {
      rule: 'Use only an exact mcpUrl returned by a future authenticated platform contract. This standalone release does not return project MCP URLs.',
      forbidden: ['hardcoded project MCP URLs', 'derived project slugs', 'guessed hosts', 'api.spala.ai/{project}/mcp'],
    },
    tools: {
      public: PUBLIC_TOOLS,
      authenticated: AUTHENTICATED_TOOLS,
    },
    toolCapabilities: allToolCapabilities(),
    authRequiredTools: projectToolCapabilities(config).map(tool => tool.name),
    authFailureHint: PROJECT_AUTH_FAILURE_HINT,
    projectCreateCapability: projectToolCapabilities(config).find(tool => tool.name === 'project_create'),
    links: discoveryLinks(),
    projectHandoffExample: PROJECT_HANDOFF_EXAMPLE,
    projectHandoffStatus: PROJECT_HANDOFF_STATUS,
  });
});

app.get('/.well-known/glama.json', (_req, res) => {
  setDiscoveryCache(res);
  res.json(GLAMA_CONNECTOR_VERIFICATION);
});

app.get('/.well-known/mcp/server-card.json', (_req, res) => {
  setDiscoveryCache(res);
  res.json(smitheryServerCard());
});

app.get('/mcp/.well-known/mcp/server-card.json', (_req, res) => {
  setDiscoveryCache(res);
  res.json(smitheryServerCard());
});

app.get('/.well-known/oauth-protected-resource', (_req, res) => {
  setDiscoveryCache(res);
  res.json(protectedResourceMetadata());
});

app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
  setDiscoveryCache(res);
  res.json(protectedResourceMetadata());
});

app.get('/mcp/.well-known/oauth-protected-resource', (_req, res) => {
  setDiscoveryCache(res);
  res.json(protectedResourceMetadata());
});

for (const path of [
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-authorization-server/mcp',
  '/mcp/.well-known/oauth-authorization-server',
]) {
  app.get(path, (_req, res) => res.redirect(308, canonicalAuthorizationServerMetadataUrl()));
}

for (const path of [
  '/.well-known/openid-configuration',
  '/.well-known/openid-configuration/mcp',
]) {
  app.get(path, (_req, res) => res.redirect(308, canonicalOpenIdMetadataUrl()));
}

app.get('/mcp/install-manifest', (_req, res) => {
  setDiscoveryCache(res);
  const mcpUrl = publicMcpUrl();
  res.json({
    schemaVersion: 1,
    name: 'Spala Public MCP',
    serverName: PUBLIC_MCP_SERVER_NAME,
    mcpUrl,
    manifestUrl: `${mcpUrl}/install-manifest`,
    transport: 'streamable-http',
    protocolCompatibility: PROTOCOL_COMPATIBILITY,
    maintainer: MAINTAINER,
    auth: 'spala_platform_auth',
    authNotes: 'Project tools require verified Spala platform auth. Token validation is currently unavailable, so no bearer credential enables a project operation.',
    role: 'public-spala-mcp',
    upstreamApi: config.spalaApiBaseUrl,
    upstreamApiNote: 'Control-plane API context only. Do not configure api.spala.ai or api.spala.ai/mcp as the Spala Public MCP server.',
    dashboardUrl: config.dashboardUrl,
    agentStartUrl: AGENT_START_URL,
    links: discoveryLinks(),
    projectMcpResolution: {
      source: 'Unavailable in this standalone release; requires a future existing generic authenticated Spala platform contract.',
      rule: 'Use only an exact mcpUrl returned by a future authenticated platform contract.',
      note: 'Agents must not derive, guess, append /mcp to arbitrary URLs, or hardcode project MCP URLs from project names, slugs, hosts, or api.spala.ai patterns.',
    },
    oauth: {
      protectedResourceMetadata: protectedResourceMetadataUrl(),
      authorizationServerMetadata: canonicalAuthorizationServerMetadataUrl(),
      authorizationServer: platformAuthServerUrl(),
      note: authServerOnlyNote(),
    },
    publicTools: PUBLIC_TOOLS,
    authenticatedTools: AUTHENTICATED_TOOLS,
    toolCapabilities: allToolCapabilities(),
    authRequiredTools: projectToolCapabilities(config).map(tool => tool.name),
    authFailureHint: PROJECT_AUTH_FAILURE_HINT,
    authenticatedToolNotes: {
      project_list: 'Blocked until project handoff is enabled for the public MCP.',
      project_select: 'Blocked until project handoff is enabled for the public MCP.',
      project_get_mcp_manifest: 'Blocked until project handoff is enabled for the public MCP.',
      project_get_public_context: 'Blocked until project handoff is enabled for the public MCP.',
      project_create: config.dryRunProjectCreate
        ? 'Configured as dry-run only, but blocked until the caller can be verified. It never creates a real project.'
        : 'Creates a project for the authenticated user when project creation is enabled.',
    },
    dryRunProjectCreate: config.dryRunProjectCreate,
    projectCreateCapability: projectToolCapabilities(config).find(tool => tool.name === 'project_create'),
    projectMcpTestTemplate: `${config.publicBaseUrl}/.well-known/project-mcp-test.json`,
    projectHandoffExample: PROJECT_HANDOFF_EXAMPLE,
    projectHandoffStatus: PROJECT_HANDOFF_STATUS,
    commands: {
      installerNpm: 'npx @spala-ai/mcp-install --public --yes',
      installerPnpm: 'pnpm dlx @spala-ai/mcp-install --public --yes',
      codexAdd: `codex mcp add ${PUBLIC_MCP_SERVER_NAME} --url ${JSON.stringify(mcpUrl)}`,
      codexLogin: `codex mcp login ${PUBLIC_MCP_SERVER_NAME} --scopes api`,
      claudeCode: `claude mcp add --transport http ${PUBLIC_MCP_SERVER_NAME} ${JSON.stringify(mcpUrl)}`,
      geminiCliUser: `gemini mcp add --scope user --transport http ${PUBLIC_MCP_SERVER_NAME} ${JSON.stringify(mcpUrl)}`,
    },
  });
});

app.get('/.well-known/project-mcp-test.json', (_req, res) => {
  setDiscoveryCache(res);
  res.json(projectMcpTestTemplate());
});

app.get('/.well-known/project-mcp-test.md', (_req, res) => {
  setDiscoveryCache(res);
  res.type('text/markdown; charset=utf-8').send(projectMcpTestMarkdown());
});

app.get('/mcp', (_req, res) => {
  res.json({
    name: 'Spala Public MCP',
    purpose: 'Discovery, OAuth metadata, and a fail-closed project tool interface for Spala.',
    mcpUrl: publicMcpUrl(),
    usage: 'Use POST with MCP JSON-RPC for protocol requests. This GET response is a human and crawler-friendly endpoint description.',
    maintainer: MAINTAINER,
    protocolCompatibility: PROTOCOL_COMPATIBILITY,
    links: discoveryLinks(),
    oauth: {
      protectedResourceMetadata: protectedResourceMetadataUrl(),
      authorizationServerMetadata: canonicalAuthorizationServerMetadataUrl(),
      deviceAuthorizationEndpoint: `${platformAuthServerUrl()}/oauth/device_authorization`,
    },
    publicTools: PUBLIC_TOOLS,
    authenticatedTools: AUTHENTICATED_TOOLS,
    toolCapabilities: allToolCapabilities(),
    authRequiredTools: projectToolCapabilities(config).map(tool => tool.name),
    authFailureHint: PROJECT_AUTH_FAILURE_HINT,
    projectCreateCapability: projectToolCapabilities(config).find(tool => tool.name === 'project_create'),
    projectHandoffExample: PROJECT_HANDOFF_EXAMPLE,
  });
});

app.post('/mcp', async (req, res) => {
  if (!isValidJsonRpcRequest(req.body)) {
    invalidRequestResponse(res, jsonRpcId(req.body));
    return;
  }

  if (req.body.method === 'initialize') {
    const protocolVersion = (req.body as { params?: { protocolVersion?: unknown } }).params?.protocolVersion;
    if (typeof protocolVersion === 'string' && !ACCEPTED_PROTOCOL_VERSIONS.includes(protocolVersion as typeof ACCEPTED_PROTOCOL_VERSIONS[number])) {
      jsonRpcErrorResponse(res, 400, -32000, 'Unsupported MCP protocol version', jsonRpcId(req.body), {
        supportedProtocolVersions: ACCEPTED_PROTOCOL_VERSIONS,
      });
      return;
    }
  }

  if (isProjectToolCall(req.body)) {
    if (!hasJsonRpcId(req.body)) {
      res.status(202).end();
      return;
    }
    if (!hasBearerCredential(req)) {
      authChallengeResponse(res, jsonRpcId(req.body));
      return;
    }
    authValidationUnavailableResponse(res, jsonRpcId(req.body));
    return;
  }

  const server = createSpalaPublicMcpServer(config, api);
  let transport: StreamableHTTPServerTransport | null = null;
  try {
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        id: jsonRpcId(req.body),
        error: { code: -32603, message: 'Internal error' },
      });
    }
  } finally {
    await server.close().catch(() => undefined);
  }
});

app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const tooLarge = (error as { type?: unknown })?.type === 'entity.too.large';
  const status = tooLarge ? 413 : 500;
  if (req.path === '/mcp') {
    res.status(status).json({
      jsonrpc: '2.0',
      id: jsonRpcId(req.body),
      error: {
        code: tooLarge ? -32600 : -32603,
        message: tooLarge ? 'Request body too large' : 'Internal server error',
      },
    });
    return;
  }
  res.status(status).json({ error: tooLarge ? 'request_too_large' : 'internal_server_error' });
});

export { app, config };

export function startServer() {
  if (typeof config.port === 'string') {
    if (existsSync(config.port) && statSync(config.port).isSocket()) {
      unlinkSync(config.port);
    }
    return app.listen(config.port, () => {
      console.log(`mcp-spala-ai listening on ${config.port}`);
      console.log(`Public MCP URL: ${config.publicBaseUrl}/mcp`);
    });
  }

  return app.listen(config.port, '127.0.0.1', () => {
    console.log(`mcp-spala-ai listening on http://127.0.0.1:${config.port}`);
    console.log(`Public MCP URL: ${config.publicBaseUrl}/mcp`);
  });
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) {
  startServer();
}
