import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { addonCatalog, docsIndex, searchCatalog, templateCatalog } from './catalog.js';
import type { AppConfig } from './config.js';
import { ProjectHandoffUnavailableError, type SpalaApiClient, type SpalaProject } from './spalaApi.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export type RequestContext = {
  verifiedPrincipal?: {
    subject: string;
  };
};

const PROJECT_SELECTOR_SCHEMA = {
  projectId: z.string().trim().min(1).max(256).optional(),
  slug: z.string().trim().min(1).max(256).optional(),
};

const PROJECT_SELECTOR_JSON_SCHEMA = {
  type: 'object',
  description: 'Provide exactly one project selector: projectId or slug.',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['projectId'],
      properties: {
        projectId: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description: 'Exact Spala project ID. Mutually exclusive with slug.',
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['slug'],
      properties: {
        slug: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description: 'Exact Spala project slug. Mutually exclusive with projectId.',
        },
      },
    },
  ],
  properties: {
    projectId: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      description: 'Exact Spala project ID. Mutually exclusive with slug.',
    },
    slug: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      description: 'Exact Spala project slug. Mutually exclusive with projectId.',
    },
  },
  additionalProperties: false,
} as const;

type ProjectSelector = {
  projectId?: string;
  slug?: string;
};

type ListToolsHandler = (request: unknown, extra: unknown) => Promise<unknown> | unknown;

function advertiseProjectSelectorXor(server: McpServer): void {
  const internals = server as unknown as {
    setToolRequestHandlers?: () => void;
    server: {
      _requestHandlers?: Map<string, ListToolsHandler>;
      setRequestHandler: typeof server.server.setRequestHandler;
    };
  };
  internals.setToolRequestHandlers?.();
  const original = internals.server._requestHandlers?.get('tools/list');
  if (!original) return;

  internals.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await original(request, extra) as { tools?: Array<{ name?: string; inputSchema?: unknown }> };
    for (const tool of result.tools || []) {
      if (['project_select', 'project_get_mcp_manifest', 'project_get_public_context'].includes(tool.name || '')) {
        tool.inputSchema = PROJECT_SELECTOR_JSON_SCHEMA;
      }
    }
    return result;
  });
}

export const PUBLIC_TOOL_CAPABILITIES = [
  { name: 'spala_help', requiresAuth: false, effect: 'read', purpose: 'Explain what Spala is, what the public MCP does, and where agents should start before authentication.' },
  { name: 'spala_get_onboarding', requiresAuth: false, effect: 'read', purpose: 'Return first-call onboarding for agents, including the public MCP role, project MCP role, auth metadata, standalone fail-closed boundary, and required first project-MCP calls once a real project MCP is known.' },
  { name: 'spala_get_tool_map', requiresAuth: false, effect: 'read', purpose: 'Return machine-readable public MCP vs project MCP routing, auth-gated tool names, OAuth metadata URLs, and the standalone boundary that project lookup, selection, and handoff are unavailable.' },
  { name: 'docs_search', requiresAuth: false, effect: 'read', purpose: 'Search public Spala agent-facing docs for setup, OAuth, npm install, unavailable project handoff, pricing, security, limits, and MCP boundary questions.' },
  { name: 'template_list', requiresAuth: false, effect: 'read', purpose: 'List public Spala backend templates so agents can plan backend shape before using the dashboard or a separately provided project MCP.' },
  { name: 'addon_list', requiresAuth: false, effect: 'read', purpose: 'List public Spala addons and integrations so agents can plan backend workflows before using the dashboard or a separately provided project MCP.' },
];

export function projectToolCapabilities(config: AppConfig) {
  return [
    {
      name: 'project_list',
      requiresAuth: true,
      available: false,
      blocker: 'Token validation and a generic authenticated platform project-management contract are unavailable.',
      effect: 'read',
      authFailureHint: 'Missing bearer: HTTP 401 OAuth challenge. Bearer present: HTTP 503 auth_validation_unavailable until this service has a verifier contract.',
      purpose: 'List projects available to the authenticated Spala platform user. Use this after OAuth; anonymous public MCP calls cannot list projects.',
    },
    {
      name: 'project_create',
      requiresAuth: true,
      dryRunOnly: config.dryRunProjectCreate,
      implemented: true,
      available: false,
      blocker: 'Token validation is unavailable; the dry-run cannot execute for an unverified caller.',
      effect: config.dryRunProjectCreate ? 'no-op' : 'write',
      authFailureHint: 'Missing bearer: HTTP 401 OAuth challenge. Bearer present: HTTP 503 auth_validation_unavailable until this service has a verifier contract.',
      purpose: config.dryRunProjectCreate
        ? 'Dry-run planning preview only in this deployment. Does not create a real project.'
        : 'Create a real Spala project through the authenticated platform API.',
    },
    {
      name: 'project_select',
      requiresAuth: true,
      available: false,
      blocker: 'No existing generic authenticated platform project-management contract is available.',
      effect: 'read',
      authFailureHint: 'Missing bearer: HTTP 401 OAuth challenge. Bearer present: HTTP 503 auth_validation_unavailable until this service has a verifier contract.',
      purpose: 'Unavailable in this standalone release. Future compatible contracts may select a project and return an exact project mcpUrl; agents must not infer this URL from a slug, host, or api.spala.ai pattern.',
    },
    {
      name: 'project_get_mcp_manifest',
      requiresAuth: true,
      available: false,
      blocker: 'No existing generic authenticated platform project-management contract is available.',
      effect: 'read',
      authFailureHint: 'Missing bearer: HTTP 401 OAuth challenge. Bearer present: HTTP 503 auth_validation_unavailable until this service has a verifier contract.',
      purpose: 'Unavailable in this standalone release. Future compatible contracts may return a selected project MCP install manifest shape with the exact mcpUrl, transport, and install URL.',
    },
    {
      name: 'project_get_public_context',
      requiresAuth: true,
      available: false,
      blocker: 'No existing generic authenticated platform project-management contract is available.',
      effect: 'read',
      authFailureHint: 'Missing bearer: HTTP 401 OAuth challenge. Bearer present: HTTP 503 auth_validation_unavailable until this service has a verifier contract.',
      purpose: 'Unavailable in this standalone release. Future compatible contracts may return safe project handoff context without exposing tokens, private source code, or unrelated customer data.',
    },
  ];
}

function text(value: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: value }], isError };
}

function json(value: unknown, isError = false): ToolResult {
  return text(JSON.stringify(value, null, 2), isError);
}

function requireVerifiedPrincipal(ctx: RequestContext, tool: string): string | ToolResult {
  if (ctx.verifiedPrincipal) return ctx.verifiedPrincipal.subject;
  return json({
    error: 'auth_validation_unavailable',
    tool,
    message: 'Project operations are disabled because this standalone service has no token verifier contract. Bearer syntax is never treated as authentication.',
  }, true);
}

function projectAuthMetadata(config: AppConfig): Record<string, unknown> {
  return {
    securitySchemes: [{ type: 'oauth2', scopes: ['api'] }],
    'spala.ai/auth': {
      required: true,
      tokenValidation: 'unavailable',
      available: false,
      missingBearerBehavior: 'HTTP 401 with WWW-Authenticate OAuth challenge',
      bearerPresentBehavior: 'HTTP 503 auth_validation_unavailable before tool processing',
      protectedResourceMetadata: `${config.publicBaseUrl}/.well-known/oauth-protected-resource/mcp`,
    },
  };
}

export function parseProjectSelector(input: ProjectSelector): ProjectSelector | ToolResult {
  const projectId = input.projectId?.trim();
  const slug = input.slug?.trim();
  if (Number(projectId !== undefined) + Number(slug !== undefined) !== 1) {
    return json({
      error: 'invalid_project_selector',
      message: 'Provide exactly one of projectId or slug.',
    }, true);
  }
  return projectId !== undefined ? { projectId } : { slug };
}

function projectContractError(): ToolResult {
  return json({
    error: 'project_handoff_contract_unavailable',
    message: 'Project lookup is disabled because the platform does not expose an existing generic authenticated project-management contract for this MCP resource.',
    action: 'Use the Spala dashboard until a compatible generic platform contract is available.',
  }, true);
}

function safeProjectError(error: unknown, fallback: string): ToolResult {
  if (error instanceof ProjectHandoffUnavailableError) return projectContractError();
  return json({ error: fallback, message: 'The project operation could not be completed.' }, true);
}

function byIdOrSlug(projects: SpalaProject[], projectId?: string, slug?: string): SpalaProject | null {
  return projects.find(project =>
    (projectId && project.id === projectId) ||
    (slug && project.slug === slug)
  ) || null;
}

export function createSpalaPublicMcpServer(config: AppConfig, api: SpalaApiClient, ctx: RequestContext = {}): McpServer {
  const server = new McpServer({
    name: 'Spala Public MCP',
    version: '0.1.0',
  }, {
    instructions: [
      'This is the standalone public Spala MCP for mcp.spala.ai.',
      'Use it for discovery, docs/templates/addons, OAuth metadata, and a fail-closed project tool interface.',
      'Token validation, project listing, project selection, and project MCP handoff are unavailable in this standalone release.',
      'Agents must not construct, append, or infer project MCP URLs.',
      'Do not mutate project backend internals here. Use the returned project MCP for backend changes.',
    ].join('\n'),
  });

  server.tool('spala_help', 'Explain what Spala is and how agents should start.', {}, async () => text([
    '# Spala Public MCP',
    '',
    'Spala is the backend control layer for AI-built apps.',
    '',
    'Use this public MCP to discover Spala, list templates/addons/docs, and inspect the fail-closed authenticated project interface.',
    'Token validation, project lookup, project selection, and MCP URL handoff are unavailable in this standalone release and fail closed until the platform exposes an existing generic project-management contract for this MCP resource.',
    '',
    'Use the project MCP for backend changes: models, endpoints, auth, logic, validation, publish, and review.',
    '',
    `Public MCP: ${config.publicBaseUrl}/mcp`,
    'Agent start: https://spala.ai/agents.md',
    `Public MCP docs: ${config.docsUrl}`,
    `Dashboard: ${config.dashboardUrl}`,
    `Docs: ${config.docsUrl}`,
  ].join('\n')));

  server.tool('spala_get_onboarding', 'First call for agents connected to mcp.spala.ai public MCP.', {}, async () => json({
    product: 'Spala',
    publicMcpRole: 'Agent discovery, public docs/templates/addons lookup, OAuth metadata, and fail-closed project tool discovery.',
    projectMcpRole: 'Build and operate one Spala backend project.',
    workflow: [
      'Call spala_get_tool_map.',
      'Search docs/templates/addons if needed.',
      'Authenticate through the Spala platform/dashboard flow when using project tools.',
      'Project tools are unavailable in this standalone release because token validation and a generic authenticated project-management contract are unavailable.',
      'project_create is defined as dry-run only, but it also cannot execute for an unverified caller in this standalone release.',
      'Use the dashboard for project discovery/creation until a compatible platform contract exists.',
      'If a future authenticated platform contract returns a project MCP URL, connect only to that exact URL. Do not infer a URL pattern.',
      'On project MCP call mcp_get_onboarding, mcp_get_tool_map, mcp_list_skills, mcp_get_skill({ name: "spala-developer" }), and project_get_builder_context.',
    ],
    urls: {
      publicMcp: `${config.publicBaseUrl}/mcp`,
      agentStart: 'https://spala.ai/agents.md',
      mcpProfile: config.docsUrl,
      publicMcpDocs: config.docsUrl,
      npmInstaller: 'https://www.npmjs.com/package/@spala-ai/mcp-install',
      launchKit: 'https://spala.ai/launch-kit/',
      security: 'https://spala.ai/security/',
      dashboard: config.dashboardUrl,
      docs: config.docsUrl,
      upstreamApi: config.spalaApiBaseUrl,
    },
    handoffExample: {
      projectId: 'proj_xxx',
      name: 'Example Project',
      mcpUrl: 'https://returned-by-spala.example/mcp',
      transport: 'streamable-http',
      note: 'Example only. This standalone release cannot validate tokens or return project MCP URLs.',
    },
  }));

  server.tool('spala_get_tool_map', 'Return machine-readable public MCP vs project MCP routing.', {}, async () => json({
    publicMcp: {
      host: 'mcp.spala.ai',
      tools: {
        discovery: ['spala_help', 'spala_get_onboarding', 'spala_get_tool_map', 'docs_search', 'template_list', 'addon_list'],
        projectHandoff: ['project_list', 'project_create', 'project_select', 'project_get_mcp_manifest', 'project_get_public_context'],
      },
      toolCapabilities: [...PUBLIC_TOOL_CAPABILITIES, ...projectToolCapabilities(config)],
      authRequiredTools: projectToolCapabilities(config).map(tool => tool.name),
      authFailureHint: 'Missing bearer returns HTTP 401 OAuth metadata; a supplied bearer returns HTTP 503 because token validation is unavailable in this standalone release.',
      projectHandoffStatus: {
        available: false,
        code: 'project_handoff_contract_unavailable',
        reason: 'Token validation, project listing, project selection, and project MCP URL handoff are unavailable in this standalone release.',
      },
      urlResolution: {
        rule: 'Do not hardcode, construct, append, or infer project MCP URL patterns.',
        preferredSource: 'Unavailable in this standalone release; requires an exact mcpUrl from a future authenticated platform contract.',
        returnedBy: [],
        useField: 'mcpUrl',
        forbidden: ['derived project slugs', 'guessed hosts', 'api.spala.ai/{project}/mcp'],
      },
      projectCreate: config.dryRunProjectCreate
        ? 'Dry-run only in this deployment. It returns a simulated planning shape and does not create a real project.'
        : 'Creates a real Spala project through the authenticated platform API.',
      oauth: {
        protectedResourceMetadata: `${config.publicBaseUrl}/.well-known/oauth-protected-resource/mcp`,
        authorizationServerMetadata: `${config.spalaApiBaseUrl}/.well-known/oauth-authorization-server/mcp`,
        authorizationEndpoint: `${config.spalaApiBaseUrl}/mcp/oauth/authorize`,
        tokenEndpoint: `${config.spalaApiBaseUrl}/mcp/oauth/token`,
        deviceAuthorizationEndpoint: `${config.spalaApiBaseUrl}/mcp/oauth/device_authorization`,
        scope: 'api',
      },
    },
    projectMcp: {
      host: 'resolved Spala project runtime',
      role: 'Project-scoped backend builder MCP.',
      firstCalls: ['mcp_get_onboarding', 'mcp_get_tool_map', 'mcp_list_skills', 'mcp_get_skill({ name: "spala-developer" })', 'project_get_builder_context'],
      handoffExample: {
        projectId: 'proj_xxx',
        name: 'Example Project',
        mcpUrl: 'https://returned-by-spala.example/mcp',
        transport: 'streamable-http',
      },
    },
  }));

  server.tool('docs_search', 'Search Spala agent-facing docs index.', {
    query: z.string().default(''),
    limit: z.number().int().min(1).max(20).default(5),
  }, async ({ query, limit }) => json({ query, results: searchCatalog(docsIndex, query, limit) }));

  server.tool('template_list', 'List Spala backend templates for agent planning.', {
    query: z.string().default(''),
    limit: z.number().int().min(1).max(50).default(20),
  }, async ({ query, limit }) => json({ query, templates: searchCatalog(templateCatalog, query, limit) }));

  server.tool('addon_list', 'List Spala addons/integrations for backend planning.', {
    query: z.string().default(''),
    limit: z.number().int().min(1).max(50).default(20),
  }, async ({ query, limit }) => json({ query, addons: searchCatalog(addonCatalog, query, limit) }));

  server.registerTool('project_list', {
    description: 'AUTH REQUIRED, CURRENTLY UNAVAILABLE. Read-only. Missing credentials receive an OAuth 401 challenge; bearer credentials receive HTTP 503 until this service has a token verifier contract.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: projectAuthMetadata(config),
  }, async () => {
    const auth = requireVerifiedPrincipal(ctx, 'project_list');
    if (typeof auth !== 'string') return auth;
    try {
      return json({ projects: await api.listProjects() });
    } catch (error) {
      return safeProjectError(error, 'project_list_failed');
    }
  });

  server.registerTool('project_create', {
    description: 'AUTH REQUIRED, CURRENTLY UNAVAILABLE. DRY-RUN ONLY. Effect: no-op. Input is validated, but no preview runs until this service can verify the caller.',
    inputSchema: {
      name: z.string().trim().min(1).max(120),
      template: z.string().trim().min(1).max(128).optional(),
      description: z.string().trim().min(1).max(2_000).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: projectAuthMetadata(config),
  }, async (input) => {
    const auth = requireVerifiedPrincipal(ctx, 'project_create');
    if (typeof auth !== 'string') return auth;
    try {
      const project = await api.createProject(input);
      return json({
        project,
        dryRun: config.dryRunProjectCreate,
        created: false,
        mcpUrlResolved: false,
        warning: 'No real Spala project was created. Dry-run projects cannot be selected or resolved to an MCP URL.',
      });
    } catch (error) {
      return safeProjectError(error, 'project_create_failed');
    }
  });

  server.registerTool('project_select', {
    description: 'AUTH REQUIRED, CURRENTLY UNAVAILABLE. Read-only. Select by exactly one of projectId or slug and return an exact platform-provided mcpUrl.',
    inputSchema: PROJECT_SELECTOR_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: projectAuthMetadata(config),
  }, async (input) => {
    const selector = parseProjectSelector(input);
    if ('content' in selector) return selector;
    const { projectId, slug } = selector;
    const auth = requireVerifiedPrincipal(ctx, 'project_select');
    if (typeof auth !== 'string') return auth;
    try {
      const selected = byIdOrSlug(await api.listProjects(), projectId, slug);
      const project = selected ? await api.resolveProjectAccess(selected) : null;
      if (!project) return json({ error: 'project_not_found' }, true);
      if (!project.mcpUrl) {
        return json({
          error: 'project_mcp_url_not_resolved',
          message: 'The platform did not return an explicit valid project MCP URL.',
        }, true);
      }
      return json({
        project,
        mcpUrl: project.mcpUrl,
        transport: 'streamable-http',
        next: 'Connect this resolved project MCP and call mcp_get_onboarding.',
        rule: 'Use this exact mcpUrl. Do not guess or derive project MCP URLs.',
      });
    } catch (error) {
      return safeProjectError(error, 'project_select_failed');
    }
  });

  server.registerTool('project_get_mcp_manifest', {
    description: 'AUTH REQUIRED, CURRENTLY UNAVAILABLE. Read-only. Select by exactly one of projectId or slug and return the project MCP install manifest.',
    inputSchema: PROJECT_SELECTOR_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: projectAuthMetadata(config),
  }, async (input) => {
    const selector = parseProjectSelector(input);
    if ('content' in selector) return selector;
    const { projectId, slug } = selector;
    const auth = requireVerifiedPrincipal(ctx, 'project_get_mcp_manifest');
    if (typeof auth !== 'string') return auth;
    try {
      const selected = byIdOrSlug(await api.listProjects(), projectId, slug);
      const project = selected ? await api.resolveProjectAccess(selected) : null;
      if (!project || !project.mcpUrl) return json({ error: 'project_not_found_or_missing_mcp_url' }, true);
      return json({
        schemaVersion: 1,
        name: 'Spala Project MCP',
        project,
        mcpUrl: project.mcpUrl,
        installManifestUrl: `${project.mcpUrl}/install-manifest`,
        transport: 'streamable-http',
        auth: 'oauth',
        rule: 'Use this exact mcpUrl for project MCP. Do not derive a URL from the project slug or api.spala.ai.',
      });
    } catch (error) {
      return safeProjectError(error, 'project_manifest_failed');
    }
  });

  server.registerTool('project_get_public_context', {
    description: 'AUTH REQUIRED, CURRENTLY UNAVAILABLE. Read-only. Future contract only: select by exactly one of projectId or slug and return safe project handoff context.',
    inputSchema: PROJECT_SELECTOR_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: projectAuthMetadata(config),
  }, async (input) => {
    const selector = parseProjectSelector(input);
    if ('content' in selector) return selector;
    const { projectId, slug } = selector;
    const auth = requireVerifiedPrincipal(ctx, 'project_get_public_context');
    if (typeof auth !== 'string') return auth;
    try {
      const selected = byIdOrSlug(await api.listProjects(), projectId, slug);
      const project = selected ? await api.resolveProjectAccess(selected) : null;
      if (!project) return json({ error: 'project_not_found' }, true);
      return json({
        project,
        handoff: {
          mcpUrl: project.mcpUrl,
          firstCalls: ['mcp_get_onboarding', 'mcp_get_tool_map', 'mcp_list_skills', 'mcp_get_skill({ name: "spala-developer" })', 'project_get_builder_context'],
        },
      });
    } catch (error) {
      return safeProjectError(error, 'project_context_failed');
    }
  });

  advertiseProjectSelectorXor(server);
  return server;
}
