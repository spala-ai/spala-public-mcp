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

const NO_ARGUMENTS_JSON_SCHEMA = {
  type: 'object',
  description: 'No arguments. Call this tool with an empty object.',
  properties: {},
  additionalProperties: false,
} as const;

const SEARCH_JSON_SCHEMA = {
  type: 'object',
  description: 'Optional text search and result limit for public Spala documentation.',
  properties: {
    query: {
      type: 'string',
      description: 'Optional search phrase. Use words such as auth, OAuth, MCP, templates, addons, pricing, limits, frontend handoff, or project handoff.',
      default: '',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 20,
      description: 'Maximum number of ranked documentation results to return.',
      default: 5,
    },
  },
  additionalProperties: false,
} as const;

const CATALOG_LIST_JSON_SCHEMA = {
  type: 'object',
  description: 'Optional catalog search and result limit for public Spala planning resources.',
  properties: {
    query: {
      type: 'string',
      description: 'Optional filter phrase for matching public Spala templates or addons by name, tag, or use case.',
      default: '',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'Maximum number of catalog entries to return.',
      default: 20,
    },
  },
  additionalProperties: false,
} as const;

const PROJECT_CREATE_JSON_SCHEMA = {
  type: 'object',
  description: 'Auth-gated dry-run project creation request. In this standalone public MCP deployment it validates shape only and cannot create a real project.',
  required: ['name'],
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
      description: 'Human-readable project name to validate for a future Spala backend project.',
    },
    template: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description: 'Optional public template id or template hint from template_list.',
    },
    description: {
      type: 'string',
      minLength: 1,
      maxLength: 2000,
      description: 'Optional short product/backend description for planning. Do not include secrets or private customer data.',
    },
  },
  additionalProperties: false,
} as const;

const TOOL_INPUT_SCHEMAS: Record<string, unknown> = {
  spala_help: NO_ARGUMENTS_JSON_SCHEMA,
  spala_get_onboarding: NO_ARGUMENTS_JSON_SCHEMA,
  spala_get_tool_map: NO_ARGUMENTS_JSON_SCHEMA,
  docs_search: SEARCH_JSON_SCHEMA,
  template_list: CATALOG_LIST_JSON_SCHEMA,
  addon_list: CATALOG_LIST_JSON_SCHEMA,
  project_list: NO_ARGUMENTS_JSON_SCHEMA,
  project_create: PROJECT_CREATE_JSON_SCHEMA,
  project_select: PROJECT_SELECTOR_JSON_SCHEMA,
  project_get_mcp_manifest: PROJECT_SELECTOR_JSON_SCHEMA,
  project_get_public_context: PROJECT_SELECTOR_JSON_SCHEMA,
};

const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const TOOL_DESCRIPTIONS = {
  spalaHelp: [
    'Use first when an agent, directory reviewer, or MCP client needs a human-readable overview of Spala.',
    'Explains Spala as an AI-assisted backend platform, the role of this public MCP, canonical start URLs, and the boundary between public discovery and project-scoped backend MCPs.',
    'Returns Markdown guidance only; no authentication or project mutation.',
  ].join(' '),
  onboarding: [
    'First structured call for fresh agents connected to mcp.spala.ai.',
    'Returns JSON with product positioning, public MCP role, project MCP role, OAuth metadata URLs, fail-closed project-tool status, safe workflow order, and canonical links.',
    'Use before any project lookup or backend build attempt.',
  ].join(' '),
  toolMap: [
    'Return a machine-readable routing map for Spala MCP clients.',
    'Shows which tools are public, which tools require authentication, OAuth/device-auth endpoints, unavailable project handoff status, forbidden URL-derivation patterns, and required first calls after connecting to a real project MCP.',
  ].join(' '),
  docsSearch: [
    'Search the public Spala agent-facing documentation index by query.',
    'Use for setup, OAuth/device auth, npm installer, public-vs-project MCP boundary, pricing, limits, security, launch kit, templates, addons, and project handoff questions.',
    'Returns ranked docs entries with URLs and summaries.',
  ].join(' '),
  templateList: [
    'List public Spala backend templates matching an optional query.',
    'Use before dashboard or project-MCP work to pick a likely backend shape such as marketplace, dashboard API, reservation system, inventory, or document management.',
    'Returns template ids, names, descriptions, and tags.',
  ].join(' '),
  addonList: [
    'List public Spala addons and integrations matching an optional query.',
    'Use before project work to plan workflows such as webhooks, outbound HTTP API calls, transactional email, media uploads, and realtime messaging.',
    'Returns addon ids, names, descriptions, and tags.',
  ].join(' '),
  projectList: [
    'AUTH REQUIRED; CURRENTLY FAIL-CLOSED AND UNAVAILABLE IN THIS STANDALONE PUBLIC MCP.',
    'Intended future use: list projects available to an authenticated Spala platform user.',
    'Current behavior: missing credentials receive an OAuth 401 challenge; supplied bearer credentials receive HTTP 503 because project handoff is not enabled in this standalone public MCP release.',
    'Read-only; does not guess project URLs.',
  ].join(' '),
  projectCreate: [
    'AUTH REQUIRED; CURRENTLY FAIL-CLOSED AND DRY-RUN ONLY IN THIS STANDALONE PUBLIC MCP.',
    'Intended future use: validate a requested project name/template/description and return a project-creation or planning result through an authenticated platform contract.',
    'Current behavior: no real project is created, no project MCP URL is returned, and supplied bearer credentials receive HTTP 503 until project handoff is enabled.',
  ].join(' '),
  projectSelect: [
    'AUTH REQUIRED; CURRENTLY FAIL-CLOSED AND UNAVAILABLE IN THIS STANDALONE PUBLIC MCP.',
    'Intended future use: select exactly one authenticated project by projectId or slug and return an exact platform-provided mcpUrl.',
    'Agents must never infer project MCP URLs from slugs, hosts, or api.spala.ai patterns.',
    'Current behavior: OAuth challenge without credentials; HTTP 503 with bearer until project handoff is enabled.',
  ].join(' '),
  projectManifest: [
    'AUTH REQUIRED; CURRENTLY FAIL-CLOSED AND UNAVAILABLE IN THIS STANDALONE PUBLIC MCP.',
    'Intended future use: select exactly one authenticated project by projectId or slug and return the project MCP install manifest, exact mcpUrl, transport, and auth requirements.',
    'Current behavior: no manifest or URL is resolved until project handoff is enabled.',
  ].join(' '),
  projectPublicContext: [
    'AUTH REQUIRED; CURRENTLY FAIL-CLOSED AND UNAVAILABLE IN THIS STANDALONE PUBLIC MCP.',
    'Intended future use: select exactly one authenticated project by projectId or slug and return safe handoff context for an agent without exposing tokens, private source code, or unrelated customer data.',
    'Current behavior: OAuth challenge without credentials; HTTP 503 with bearer until project handoff is enabled.',
  ].join(' '),
} as const;

type ProjectSelector = {
  projectId?: string;
  slug?: string;
};

type ListToolsHandler = (request: unknown, extra: unknown) => Promise<unknown> | unknown;

function advertiseDirectoryQualityMetadata(server: McpServer): void {
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
    const result = await original(request, extra) as { tools?: Array<{ name?: string; inputSchema?: unknown; annotations?: unknown }> };
    for (const tool of result.tools || []) {
      const schema = tool.name ? TOOL_INPUT_SCHEMAS[tool.name] : undefined;
      if (schema) {
        tool.inputSchema = schema;
      }
      if (tool.name && ['spala_help', 'spala_get_onboarding', 'spala_get_tool_map', 'docs_search', 'template_list', 'addon_list'].includes(tool.name)) {
        tool.annotations = READ_ONLY_TOOL_ANNOTATIONS;
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
      blocker: 'Project handoff is not enabled in this standalone public MCP release.',
      effect: 'read',
      authFailureHint: 'Missing bearer: HTTP 401 OAuth challenge. Bearer present: HTTP 503 project_handoff_unavailable until project handoff is enabled.',
      purpose: 'List projects available to the authenticated Spala platform user. Use this after OAuth; anonymous public MCP calls cannot list projects.',
    },
    {
      name: 'project_create',
      requiresAuth: true,
      dryRunOnly: config.dryRunProjectCreate,
      implemented: true,
      available: false,
      blocker: 'Project handoff is not enabled; the dry-run cannot execute for an unverified caller.',
      effect: config.dryRunProjectCreate ? 'no-op' : 'write',
      authFailureHint: 'Missing bearer: HTTP 401 OAuth challenge. Bearer present: HTTP 503 project_handoff_unavailable until project handoff is enabled.',
      purpose: config.dryRunProjectCreate
        ? 'Dry-run planning preview only in this deployment. Does not create a real project.'
        : 'Create a real Spala project through the authenticated platform API.',
    },
    {
      name: 'project_select',
      requiresAuth: true,
      available: false,
      blocker: 'Project handoff is not enabled in this standalone public MCP release.',
      effect: 'read',
      authFailureHint: 'Missing bearer: HTTP 401 OAuth challenge. Bearer present: HTTP 503 project_handoff_unavailable until project handoff is enabled.',
      purpose: 'Unavailable in this standalone release. Future compatible contracts may select a project and return an exact project mcpUrl; agents must not infer this URL from a slug, host, or api.spala.ai pattern.',
    },
    {
      name: 'project_get_mcp_manifest',
      requiresAuth: true,
      available: false,
      blocker: 'Project handoff is not enabled in this standalone public MCP release.',
      effect: 'read',
      authFailureHint: 'Missing bearer: HTTP 401 OAuth challenge. Bearer present: HTTP 503 project_handoff_unavailable until project handoff is enabled.',
      purpose: 'Unavailable in this standalone release. Future compatible contracts may return a selected project MCP install manifest shape with the exact mcpUrl, transport, and install URL.',
    },
    {
      name: 'project_get_public_context',
      requiresAuth: true,
      available: false,
      blocker: 'Project handoff is not enabled in this standalone public MCP release.',
      effect: 'read',
      authFailureHint: 'Missing bearer: HTTP 401 OAuth challenge. Bearer present: HTTP 503 project_handoff_unavailable until project handoff is enabled.',
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
    error: 'project_handoff_unavailable',
    tool,
    message: 'Project operations are disabled because project handoff is not enabled in this standalone public MCP release. Bearer syntax is never treated as authentication.',
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
      bearerPresentBehavior: 'HTTP 503 project_handoff_unavailable before tool processing',
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
    error: 'project_handoff_unavailable',
    message: 'Project lookup is disabled because project handoff is not enabled for this public MCP release.',
    action: 'Use the Spala dashboard until project handoff is enabled.',
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

  server.tool('spala_help', TOOL_DESCRIPTIONS.spalaHelp, {}, async () => text([
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

  server.tool('spala_get_onboarding', TOOL_DESCRIPTIONS.onboarding, {}, async () => json({
    product: 'Spala',
    publicMcpRole: 'Agent discovery, public docs/templates/addons lookup, OAuth metadata, and fail-closed project tool discovery.',
    projectMcpRole: 'Build and operate one Spala backend project.',
    workflow: [
      'Call spala_get_tool_map.',
      'Search docs/templates/addons if needed.',
      'Authenticate through the Spala platform/dashboard flow when using project tools.',
      'Project tools are unavailable in this standalone release because project handoff is not enabled for the public MCP.',
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
      note: 'Example only. This standalone release cannot return project MCP URLs.',
    },
  }));

  server.tool('spala_get_tool_map', TOOL_DESCRIPTIONS.toolMap, {}, async () => json({
    publicMcp: {
      host: 'mcp.spala.ai',
      tools: {
        discovery: ['spala_help', 'spala_get_onboarding', 'spala_get_tool_map', 'docs_search', 'template_list', 'addon_list'],
        projectHandoff: ['project_list', 'project_create', 'project_select', 'project_get_mcp_manifest', 'project_get_public_context'],
      },
      toolCapabilities: [...PUBLIC_TOOL_CAPABILITIES, ...projectToolCapabilities(config)],
      authRequiredTools: projectToolCapabilities(config).map(tool => tool.name),
      authFailureHint: 'Missing bearer returns HTTP 401 OAuth metadata; a supplied bearer returns HTTP 503 project_handoff_unavailable because project handoff is not enabled in this standalone release.',
      projectHandoffStatus: {
        available: false,
        code: 'project_handoff_unavailable',
      reason: 'Project listing, project selection, and project MCP URL handoff are unavailable in this standalone release.',
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

  server.tool('docs_search', TOOL_DESCRIPTIONS.docsSearch, {
    query: z.string().default(''),
    limit: z.number().int().min(1).max(20).default(5),
  }, async ({ query, limit }) => json({ query, results: searchCatalog(docsIndex, query, limit) }));

  server.tool('template_list', TOOL_DESCRIPTIONS.templateList, {
    query: z.string().default(''),
    limit: z.number().int().min(1).max(50).default(20),
  }, async ({ query, limit }) => json({ query, templates: searchCatalog(templateCatalog, query, limit) }));

  server.tool('addon_list', TOOL_DESCRIPTIONS.addonList, {
    query: z.string().default(''),
    limit: z.number().int().min(1).max(50).default(20),
  }, async ({ query, limit }) => json({ query, addons: searchCatalog(addonCatalog, query, limit) }));

  server.registerTool('project_list', {
    description: TOOL_DESCRIPTIONS.projectList,
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
    description: TOOL_DESCRIPTIONS.projectCreate,
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
    description: TOOL_DESCRIPTIONS.projectSelect,
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
    description: TOOL_DESCRIPTIONS.projectManifest,
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
    description: TOOL_DESCRIPTIONS.projectPublicContext,
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

  advertiseDirectoryQualityMetadata(server);
  return server;
}
