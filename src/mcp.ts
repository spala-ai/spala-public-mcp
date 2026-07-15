import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { addonCatalog, docsIndex, searchCatalog, templateCatalog } from './catalog.js';
import type { AppConfig } from './config.js';
import { SpalaApiError, type SpalaApiClient, type SpalaPrincipal, type SpalaProject } from './spalaApi.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export type RequestContext = {
  verifiedPrincipal?: SpalaPrincipal;
};

export const SUPPORTED_INSTALL_CLIENTS = [
  'codex',
  'roo',
] as const;
const PROJECT_INSTALLER_SPEC = '@spala-ai/mcp-install@0.1.8';

type SupportedInstallClient = typeof SUPPORTED_INSTALL_CLIENTS[number];

const PROJECT_SELECTOR_SCHEMA = {
  projectId: z.string().trim().min(1).max(256).optional(),
  subdomain: z.string().trim().min(1).max(256).optional(),
  organizationId: z.string().trim().min(1).max(256).optional(),
};

const PROJECT_INSTALL_SELECTOR_SCHEMA = {
  ...PROJECT_SELECTOR_SCHEMA,
  client: z.enum(SUPPORTED_INSTALL_CLIENTS).optional(),
};

const PROJECT_SELECTOR_JSON_SCHEMA = {
  type: 'object',
  description: 'Provide exactly one project selector: projectId or subdomain. organizationId is optional when selecting by subdomain.',
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
          description: 'Exact Spala project ID. Mutually exclusive with subdomain.',
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['subdomain'],
      properties: {
        subdomain: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description: 'Exact project subdomain returned by the Spala projects API. Mutually exclusive with projectId.',
        },
        organizationId: {
          type: 'string', minLength: 1, maxLength: 256,
          description: 'Optional organization ID returned for the signed-in account.',
        },
      },
    },
  ],
  properties: {
    projectId: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      description: 'Exact Spala project ID. Mutually exclusive with subdomain.',
    },
    subdomain: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      description: 'Exact project subdomain returned by the Spala projects API. Mutually exclusive with projectId.',
    },
    organizationId: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      description: 'Optional organization ID returned for the signed-in account.',
    },
  },
  additionalProperties: false,
} as const;

const INSTALL_CLIENT_JSON_SCHEMA = {
  type: 'string',
  enum: SUPPORTED_INSTALL_CLIENTS,
  description: 'Target MCP client for @spala-ai/mcp-install. Omit to receive client_selection_required without an executable mutation plan.',
} as const;

const PROJECT_INSTALL_SELECTOR_JSON_SCHEMA = {
  ...PROJECT_SELECTOR_JSON_SCHEMA,
  description: 'Provide exactly one project selector and a supported agentic workspace client (codex or roo) to receive executable installer argv.',
  oneOf: PROJECT_SELECTOR_JSON_SCHEMA.oneOf.map(branch => ({
    ...branch,
    properties: { ...branch.properties, client: INSTALL_CLIENT_JSON_SCHEMA },
  })),
  properties: {
    ...PROJECT_SELECTOR_JSON_SCHEMA.properties,
    client: INSTALL_CLIENT_JSON_SCHEMA,
  },
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
  description: 'Create a real Spala project in an organization available to the authenticated user.',
  required: ['name'],
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
      description: 'Human-readable name for the new Spala project.',
    },
    organizationId: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      description: 'Organization ID returned for the signed-in account. Optional only when exactly one organization is available.',
    },
  },
  additionalProperties: false,
} as const;

const ACCOUNT_SETUP_JSON_SCHEMA = {
  type: 'object',
  description: 'Complete missing Spala account data after OAuth. Supply only real values confirmed by the user or confidently known from the current work context.',
  properties: {
    firstName: {
      type: 'string', minLength: 1, maxLength: 120,
      description: 'Account holder first name. Required when account_status reports firstName missing.',
    },
    lastName: {
      type: 'string', minLength: 1, maxLength: 120,
      description: 'Account holder last name. Required when account_status reports lastName missing.',
    },
    companyName: {
      type: 'string', minLength: 1, maxLength: 120,
      description: 'Company or workspace name. Required when account_status reports companyName missing.',
    },
  },
  additionalProperties: false,
} as const;

const PROJECT_LIST_JSON_SCHEMA = {
  type: 'object',
  description: 'List projects for an organization available to the authenticated user.',
  properties: {
    organizationId: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      description: 'Organization ID returned for the signed-in account. Optional only when exactly one organization is available.',
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
  account_status: NO_ARGUMENTS_JSON_SCHEMA,
  account_setup: ACCOUNT_SETUP_JSON_SCHEMA,
  project_list: PROJECT_LIST_JSON_SCHEMA,
  project_create: PROJECT_CREATE_JSON_SCHEMA,
  project_connect: PROJECT_INSTALL_SELECTOR_JSON_SCHEMA,
  project_select: PROJECT_INSTALL_SELECTOR_JSON_SCHEMA,
  project_get_mcp_manifest: PROJECT_INSTALL_SELECTOR_JSON_SCHEMA,
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
    'Returns JSON with product positioning, OAuth metadata, supported installer client identifiers, authenticated project-handoff status, safe workflow order, and canonical links.',
    'Use before any project lookup or backend build attempt.',
  ].join(' '),
  toolMap: [
    'Return a machine-readable routing map for Spala MCP clients.',
    'Shows which tools are public, which require authentication, supported installer clients, omitted-client behavior, OAuth endpoints, exact-URL rules, and required first project-MCP calls.',
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
  accountStatus: [
    'AUTH REQUIRED; READ-ONLY. Verify that the current public MCP OAuth credential is active.',
    'Returns the authenticated identity, available organizations, account readiness, and the exact missing account fields without exposing OAuth or dashboard credentials.',
    'When setup is incomplete, ask the human one concise terminal question for only the reported fields, then call account_setup before project work.',
  ].join(' '),
  accountSetup: [
    'AUTH REQUIRED; WRITES MISSING ACCOUNT DATA TO THE SPALA CONTROL PLANE.',
    'Fill missing first name and last name, and create the first company/workspace organization when none exists.',
    'Use real values supplied by the human or confidently known from explicit context. Never create placeholder account or company names.',
    'After success, ask for or confidently derive the project name, then call project_list before project_create to avoid duplicates.',
  ].join(' '),
  projectList: [
    'AUTH REQUIRED. List projects in an authoritative organization returned for the authenticated Spala user.',
    'Provide organizationId when the authenticated user has multiple organizations; a sole organization is selected automatically.',
    'Invalid subject credentials receive an OAuth 401 challenge; missing api scope returns HTTP 403; exchange or delegation failures return HTTP 503.',
    'Read-only; does not guess project URLs.',
  ].join(' '),
  projectCreate: [
    'AUTH REQUIRED; WRITES TO THE SPALA CONTROL PLANE.',
    'Create a real project with project_name and an authoritative organization_id.',
    'Provide organizationId when the authenticated user has multiple organizations; a sole organization is selected automatically. This operation is not read-only or idempotent.',
  ].join(' '),
  projectConnect: [
    'AUTH REQUIRED; IDEMPOTENT PROJECT CONNECTION WRITE. Prepare exactly one authenticated project for agent access.',
    `Provide one installer client (${SUPPORTED_INSTALL_CLIENTS.join(', ')}). When omitted, returns client_selection_required without executable argv.`,
    'The control plane verifies account and project access, then the public MCP uses the existing temporary project-entry handoff to enable MCP directly on that exact project backend.',
    'Returns the bootstrap capability separately from a workspace-only project bind argv. Feed it through installer stdin; never place it in shell text or process arguments.',
  ].join(' '),
  projectSelect: [
    'Compatibility alias for project_connect.',
    'AUTH REQUIRED; IDEMPOTENT PROJECT CONNECTION WRITE. Enables project MCP when needed and returns the same workspace-only exact-URL binding plan with one-time installer bootstrap.',
    'Agents must never infer project MCP URLs from subdomains or hosts or install project MCP globally.',
  ].join(' '),
  projectManifest: [
    'AUTH REQUIRED; IDEMPOTENT PROJECT CONNECTION WRITE. Prepare one authenticated project and return its exact platform-provided project MCP manifestUrl, mcpUrl, and executable workspace binding plan.',
    `Provide one installer client (${SUPPORTED_INSTALL_CLIENTS.join(', ')}). When omitted, returns client_selection_required without executable argv.`,
    'The installer uses project bind with exact clean URLs and immediately consumes the one-time protected bootstrap URL. Public MCP does not fetch it, and the agentic flow does not use native project OAuth.',
  ].join(' '),
  projectPublicContext: [
    'AUTH REQUIRED; READ-ONLY. Return the documented MCP handoff fields for one authenticated project without exposing tokens, private source code, or unrelated customer data. Does not require an installer client and does not return executable installer argv.',
  ].join(' '),
} as const;

type ProjectSelector = {
  projectId?: string;
  subdomain?: string;
  organizationId?: string;
  client?: SupportedInstallClient;
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
  { name: 'spala_get_onboarding', requiresAuth: false, effect: 'read', purpose: 'Return first-call onboarding for agents, including the public MCP role, project MCP role, auth metadata, enabled authenticated handoff, and required first project-MCP calls.' },
  { name: 'spala_get_tool_map', requiresAuth: false, effect: 'read', purpose: 'Return machine-readable public MCP vs project MCP routing, auth-gated tool names, OAuth metadata URLs, and exact-URL handoff rules.' },
  { name: 'docs_search', requiresAuth: false, effect: 'read', purpose: 'Search public Spala agent-facing docs for setup, OAuth, npm install, project handoff, pricing, security, limits, and MCP boundary questions.' },
  { name: 'template_list', requiresAuth: false, effect: 'read', purpose: 'List public Spala backend templates so agents can plan backend shape before using the dashboard or a separately provided project MCP.' },
  { name: 'addon_list', requiresAuth: false, effect: 'read', purpose: 'List public Spala addons and integrations so agents can plan backend workflows before using the dashboard or a separately provided project MCP.' },
];

export function projectToolCapabilities(config: AppConfig) {
  return [
    {
      name: 'account_status',
      requiresAuth: true,
      available: true,
      effect: 'read',
      authFailureHint: 'Missing, expired, or revoked bearer: HTTP 401 OAuth challenge; temporary service failure: HTTP 503.',
      purpose: 'Verify the account session and return account readiness plus exact missing profile or company fields.',
    },
    {
      name: 'account_setup',
      requiresAuth: true,
      available: true,
      effect: 'write',
      authFailureHint: 'Missing or invalid bearer: HTTP 401; missing api scope: HTTP 403; temporary service failure: HTTP 503.',
      purpose: 'Complete missing account profile data and create the first company/workspace organization without sending the user to the dashboard.',
    },
    {
      name: 'project_list',
      requiresAuth: true,
      available: true,
      effect: 'read',
      authFailureHint: 'Missing or invalid bearer: HTTP 401; missing api scope: HTTP 403; temporary service failure: HTTP 503.',
      purpose: 'List projects available to the authenticated Spala platform user. Use this after OAuth; anonymous public MCP calls cannot list projects.',
    },
    {
      name: 'project_create',
      requiresAuth: true,
      implemented: true,
      available: true,
      effect: 'write',
      authFailureHint: 'Missing or invalid bearer: HTTP 401; missing api scope: HTTP 403; temporary service failure: HTTP 503.',
      purpose: 'Create a real Spala project through the authenticated platform API.',
    },
    {
      name: 'project_connect',
      requiresAuth: true,
      available: true,
      effect: 'write',
      idempotent: true,
      workspaceOnly: true,
      authFailureHint: 'Missing, expired, or revoked bearer: HTTP 401 OAuth challenge; temporary service failure: HTTP 503.',
      purpose: 'Enable MCP for one authorized project when needed and return an exact workspace-only project binding plan.',
    },
    {
      name: 'project_select',
      requiresAuth: true,
      available: true,
      effect: 'write',
      idempotent: true,
      workspaceOnly: true,
      authFailureHint: 'Missing or invalid bearer: HTTP 401; missing api scope: HTTP 403; temporary service failure: HTTP 503.',
      purpose: 'Compatibility alias for project_connect. Prepares project MCP and returns an exact workspace-only binding plan.',
    },
    {
      name: 'project_get_mcp_manifest',
      requiresAuth: true,
      available: true,
      effect: 'write',
      idempotent: true,
      workspaceOnly: true,
      authFailureHint: 'Missing or invalid bearer: HTTP 401; missing api scope: HTTP 403; temporary service failure: HTTP 503.',
      purpose: 'Prepare project MCP and return exact mcpUrl and manifestUrl values plus workspace-only project bind argv.',
    },
    {
      name: 'project_get_public_context',
      requiresAuth: true,
      available: true,
      effect: 'read',
      authFailureHint: 'Missing or invalid bearer: HTTP 401; missing api scope: HTTP 403; temporary service failure: HTTP 503.',
      purpose: 'Return safe documented project handoff context without exposing tokens, private source code, or unrelated customer data.',
    },
  ];
}

function text(value: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: value }], isError };
}

function json(value: unknown, isError = false): ToolResult {
  return text(JSON.stringify(value, null, 2), isError);
}

type AccountSetupField = 'firstName' | 'lastName' | 'companyName';
const accountSetupLocks = new Map<string, Promise<void>>();

function missingAccountSetupFields(principal: SpalaPrincipal): AccountSetupField[] {
  return [
    ...(!principal.user.firstName ? ['firstName' as const] : []),
    ...(!principal.user.lastName ? ['lastName' as const] : []),
    ...(principal.organizations.length === 0 ? ['companyName' as const] : []),
  ];
}

async function withAccountSetupLock<T>(subject: string, operation: () => Promise<T>): Promise<T> {
  const previous = accountSetupLocks.get(subject) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  accountSetupLocks.set(subject, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (accountSetupLocks.get(subject) === current) accountSetupLocks.delete(subject);
  }
}

function requireVerifiedPrincipal(ctx: RequestContext, api: SpalaApiClient | undefined, tool: string): string | ToolResult {
  if (ctx.verifiedPrincipal && api) return ctx.verifiedPrincipal.subject;
  return json({
    error: 'authentication_required',
    tool,
    message: 'Authenticate with a Spala MCP OAuth token with api scope before using account or project tools.',
  }, true);
}

function projectAuthMetadata(config: AppConfig): Record<string, unknown> {
  return {
    securitySchemes: [{ type: 'oauth2', scopes: ['api'] }],
    'spala.ai/auth': {
      required: true,
      tokenValidation: 'Secure server-side validation and request-scoped delegation.',
      available: true,
      missingBearerBehavior: 'HTTP 401 with WWW-Authenticate OAuth challenge',
      invalidBearerBehavior: 'HTTP 401 with WWW-Authenticate OAuth challenge',
      insufficientScopeBehavior: 'HTTP 403 with WWW-Authenticate insufficient_scope challenge',
      upstreamUnavailableBehavior: 'HTTP 503 with a generic error',
      protectedResourceMetadata: `${config.publicBaseUrl}/.well-known/oauth-protected-resource/mcp`,
      authorizationServerMetadata: `${config.publicBaseUrl}/.well-known/oauth-authorization-server/mcp`,
      authorizationEndpoint: `${config.publicBaseUrl}/oauth/authorize`,
      dashboardAuthorizationUrl: `${config.dashboardUrl}/mcp/authorize`,
    },
  };
}

export function parseProjectSelector(input: ProjectSelector): ProjectSelector | ToolResult {
  const projectId = input.projectId?.trim();
  const subdomain = input.subdomain?.trim();
  const organizationId = input.organizationId?.trim();
  const client = input.client;
  if (Number(projectId !== undefined) + Number(subdomain !== undefined) !== 1) {
    return json({
      error: 'invalid_project_selector',
      message: 'Provide exactly one of projectId or subdomain.',
    }, true);
  }
  if (projectId !== undefined && organizationId !== undefined) {
    return json({
      error: 'invalid_project_selector',
      message: 'organizationId is allowed only with subdomain; projectId handoff authorization is enforced upstream.',
    }, true);
  }
  return projectId !== undefined
    ? { projectId, ...(client ? { client } : {}) }
    : { subdomain, ...(organizationId ? { organizationId } : {}), ...(client ? { client } : {}) };
}

function requireInstallClient(selector: ProjectSelector): SupportedInstallClient | ToolResult {
  if (selector.client) return selector.client;
  return json({
    error: 'client_selection_required',
    category: 'client_selection_required',
    message: 'Choose one supported agentic workspace client (codex or roo) before requesting an executable install plan.',
    supportedClients: SUPPORTED_INSTALL_CLIENTS,
    action: { type: 'select_client', argument: 'client' },
  }, true);
}

function safeProjectError(error: unknown, fallback: string, config: AppConfig): ToolResult {
  if (error instanceof SpalaApiError) {
    const planFailure = error.category === 'payment_required' || error.category === 'plan_restricted';
    const organizationSelection = error.category === 'organization_selection_required';
    const accountSetupRequired = error.code === 'organization_required';
    let action: Record<string, unknown> | undefined;
    if (error.category === 'authentication') {
      action = {
        type: 'reauthenticate_public_mcp',
        authorizationEndpoint: `${config.publicBaseUrl}/oauth/authorize`,
        requiredScope: 'api',
      };
    } else if (accountSetupRequired) {
      action = { type: 'complete_account_setup', statusTool: 'account_status', setupTool: 'account_setup' };
    } else if (organizationSelection) {
      action = { type: 'select_organization', argument: 'organizationId' };
    } else if (planFailure) {
      action = {
        type: 'human_payment_required',
        dashboardUrl: config.dashboardUrl,
        pricingUrl: config.pricingUrl,
      };
    } else if (error.category === 'forbidden') {
      action = { type: 'review_project_access', dashboardUrl: config.dashboardUrl };
    }
    return json({
      error: error.category === 'authentication' ? 'reauthentication_required' : error.code || error.category,
      category: error.category,
      status: error.status,
      message: planFailure
        ? 'Payment or an eligible plan is required. Stop and ask the human to review billing in the Spala dashboard, then retry this tool.'
        : accountSetupRequired
          ? 'The account has no company/workspace organization yet. Call account_status, ask the human for its missing fields, then call account_setup and retry.'
        : error.category === 'authentication'
          ? 'The Spala account session expired or was revoked. Reauthenticate the public MCP, then retry this tool.'
          : error.category === 'forbidden'
            ? 'Account access is required. Stop and ask the human to review project access in the Spala dashboard, then retry this tool.'
            : error.category === 'organization_selection_required'
              ? 'Choose one organization returned for the signed-in account, then retry this tool.'
              : error.category === 'not_found'
                ? 'The requested project was not found or is not available to the signed-in account.'
                : 'The project operation is temporarily unavailable. Retry later.',
      ...(error.organizationChoices ? { organizationChoices: error.organizationChoices } : {}),
      ...(action ? { action } : {}),
    }, true);
  }
  return json({ error: fallback, message: 'The project operation could not be completed.' }, true);
}

function byIdOrSubdomain(projects: SpalaProject[], projectId?: string, subdomain?: string): SpalaProject | null {
  return projects.find(project =>
    (projectId && project.id === projectId) ||
    (subdomain && project.subdomain === subdomain)
  ) || null;
}

function projectServerName(projectId: string): string {
  const suffix = createHash('sha256').update(projectId, 'utf8').digest('hex').slice(0, 12);
  return `spala_project_${suffix}`;
}

function projectMcpInstallPlan(
  handoff: Awaited<ReturnType<SpalaApiClient['prepareProjectMcp']>>,
  client: SupportedInstallClient,
) {
  if (!handoff.mcpUrl) throw new Error('Prepared project MCP URL is missing.');
  const serverName = projectServerName(handoff.projectId);
  return {
    argv: [
      'pnpm', 'dlx', PROJECT_INSTALLER_SPEC, 'project', 'bind',
      '--project-id', handoff.projectId,
      '--project-url', handoff.projectUrl,
      '--url', handoff.mcpUrl,
      '--name', serverName,
      '--client', client,
      '--install-scope', 'workspace',
      '--bootstrap-stdin',
      '--exact-url', '--yes', '--json',
    ],
    command: 'project bind',
    client,
    projectId: handoff.projectId,
    projectUrl: handoff.projectUrl,
    mcpUrl: handoff.mcpUrl,
    serverName,
    exactUrl: true,
    scopeHandling: 'preserved_from_exact_mcp_url',
    workspaceOnly: true,
    workspaceScope: 'workspace',
    installScope: 'workspace',
    bindingFile: '.spala/project.json',
    globalInstall: false,
    oneTimeBootstrap: true,
    immediateConsumptionRequired: true,
    bootstrapInput: 'stdin_single_line',
    bootstrapExposedInArgv: false,
    projectOAuthRequired: false,
    credentialMode: 'local_proxy_after_bootstrap',
    shell: false,
    urlSource: 'exact_authenticated_handoff',
    remoteManifestFetch: false,
    expectedOutput: 'JSON confirming one-time bootstrap consumption, local credential proxy setup, and the workspace binding.',
  } as const;
}

const PROJECT_MCP_INSTALL_NEXT_STEPS = [
  'Start installPlan.argv immediately from the intended local project root and send bootstrap.consumeUrl as its single stdin line through the process API. Never interpolate it into a shell command.',
  'Confirm the installer created or updated .spala/project.json and did not install this project MCP globally.',
  'Confirm the installer consumed the bootstrap URL and configured its local credential proxy. Do not store, inspect, print, or reuse the bootstrap URL.',
  'Do not start native or manual project OAuth for this agentic flow. Manual UI OAuth is separate.',
  'Call mcp_get_onboarding on the newly added project MCP.',
  'Follow the installer JSON reload instruction for the selected client.',
] as const;

async function resolveProjectId(
  api: SpalaApiClient,
  selector: ProjectSelector,
): Promise<{ project?: SpalaProject; projectId: string } | null> {
  if (selector.projectId) return { projectId: selector.projectId };
  const listed = await api.listProjects({ organizationId: selector.organizationId });
  const project = byIdOrSubdomain(listed.projects, undefined, selector.subdomain);
  return project ? { project, projectId: project.id } : null;
}

async function resolveHandoff(
  api: SpalaApiClient,
  selector: ProjectSelector,
): Promise<{ project?: SpalaProject; handoff: Awaited<ReturnType<SpalaApiClient['getProjectHandoff']>> } | null> {
  const resolved = await resolveProjectId(api, selector);
  if (!resolved) return null;
  return { project: resolved.project, handoff: await api.getProjectHandoff(resolved.projectId) };
}

async function prepareHandoff(
  api: SpalaApiClient,
  selector: ProjectSelector,
  client: SupportedInstallClient,
): Promise<{ project?: SpalaProject; handoff: Awaited<ReturnType<SpalaApiClient['prepareProjectMcp']>> } | null> {
  const resolved = await resolveProjectId(api, selector);
  if (!resolved) return null;
  return { project: resolved.project, handoff: await api.prepareProjectMcp(resolved.projectId, client) };
}

export function createSpalaPublicMcpServer(config: AppConfig, api?: SpalaApiClient, ctx: RequestContext = {}): McpServer {
  const server = new McpServer({
    name: 'Spala Public MCP',
    version: '0.1.0',
  }, {
    instructions: [
      'This is the public Spala MCP for mcp.spala.ai.',
      'Use it for discovery, docs/templates/addons, OAuth metadata, authenticated project management, and project MCP handoff.',
      'Authenticated tools use secure server-side delegation. Bearer tokens are never returned, logged, or placed in URLs; a one-time opaque bootstrap URL is passed only to the local installer.',
      'Call account_status first after OAuth. If it reports missing account data, ask the human for only those fields and call account_setup before project work.',
      'After account setup, ask for or confidently derive a real project name, then reuse the project bound to the current workspace or create one only when needed.',
      'Agents must not construct, append, or infer project MCP URLs.',
      'Do not mutate project backend internals here. Use the returned project MCP for backend changes.',
    ].join('\n'),
  });

  server.tool('spala_help', TOOL_DESCRIPTIONS.spalaHelp, {}, async () => text([
    '# Spala Public MCP',
    '',
    'Spala is the backend control layer for AI-built apps.',
    '',
    'Use this public MCP to discover Spala, list templates/addons/docs, manage authenticated projects, and obtain exact project MCP handoffs.',
      'Public tools are anonymous. Account and project tools require an api-scoped Spala MCP OAuth bearer and use secure server-side delegation.',
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
    publicMcpRole: 'Agent discovery, public docs/templates/addons lookup, OAuth metadata, authenticated project management, and exact project MCP handoff.',
    projectMcpRole: 'Build and operate one Spala backend project.',
    workflow: [
      'Call spala_get_tool_map.',
      'Search docs/templates/addons if needed.',
      'Authenticate through Spala MCP OAuth with api scope, then call account_status to verify the session is active.',
      'If account_status reports setup required, ask one concise terminal question for exactly its missingFields and call account_setup. Do not use placeholder personal, company, or workspace names.',
      'After account setup is ready, ask for or confidently derive the project name from the explicit user request.',
      'If .spala/project.json exists in the current workspace, verify and reuse that project. Otherwise call project_list and create a project only when no intended project exists.',
      `Choose one installer client: ${SUPPORTED_INSTALL_CLIENTS.join(', ')}.`,
      'Call project_connect with client. The authenticated control plane returns the existing temporary project entry handoff; public MCP then enables MCP and prepares agent instructions directly on that exact project backend.',
      'Run installPlan.argv immediately from the intended project root and feed bootstrap.consumeUrl as its single stdin line through the process API. It must bind .spala/project.json and must not install project MCP globally.',
      'The installer configures a local credential proxy after bootstrap. Do not start native or manual project OAuth for this agentic flow; manual UI OAuth is unrelated.',
      'Follow the installer JSON reload instruction for the selected client.',
      'On project MCP call mcp_get_onboarding, mcp_get_tool_map, mcp_list_skills, mcp_get_skill({ name: "spala-developer" }), and project_get_builder_context.',
    ],
    supportedInstallerClients: SUPPORTED_INSTALL_CLIENTS,
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
    },
    handoffExample: {
      projectId: 'proj_xxx',
      name: 'Example Project',
      mcpUrl: 'https://returned-by-spala.example/mcp?scope=builder%2Cproject%2Cdata',
      transport: 'streamable-http',
      note: 'Shape example only. Real URLs are returned exclusively by the authenticated mcp-handoff endpoint.',
    },
  }));

  server.tool('spala_get_tool_map', TOOL_DESCRIPTIONS.toolMap, {}, async () => json({
    publicMcp: {
      host: 'mcp.spala.ai',
      tools: {
        discovery: ['spala_help', 'spala_get_onboarding', 'spala_get_tool_map', 'docs_search', 'template_list', 'addon_list'],
        account: ['account_status', 'account_setup'],
        projectHandoff: ['project_list', 'project_create', 'project_connect', 'project_select', 'project_get_mcp_manifest', 'project_get_public_context'],
      },
      toolCapabilities: [...PUBLIC_TOOL_CAPABILITIES, ...projectToolCapabilities(config)],
      authRequiredTools: projectToolCapabilities(config).map(tool => tool.name),
      authFailureHint: 'Missing or invalid bearer returns HTTP 401; missing api scope returns HTTP 403; temporary service failures return HTTP 503.',
      projectHandoffStatus: {
        available: true,
        code: 'enabled',
        reason: 'Project connect prepares MCP server-side and returns exact workspace-only handoff URLs plus one-time installer bootstrap.',
      },
      urlResolution: {
        rule: 'Do not hardcode, construct, append, or infer project MCP URL patterns.',
        preferredSource: 'Authenticated project handoff returned by Spala.',
        returnedBy: ['project_connect', 'project_select', 'project_get_mcp_manifest', 'project_get_public_context'],
        useField: 'mcpUrl',
        forbidden: ['derived project slugs', 'guessed hosts'],
      },
      installer: {
        package: '@spala-ai/mcp-install',
        clientArgument: 'client',
        supportedClients: SUPPORTED_INSTALL_CLIENTS,
        omittedClientBehavior: 'client_selection_required without installPlan',
        command: 'project bind',
        workspaceScope: 'workspace',
        bindingFile: '.spala/project.json',
        globalProjectInstallAllowed: false,
        bootstrapArgument: '--bootstrap-stdin',
        bootstrapHandling: 'Opaque, short-lived, and one-time. It is returned separately as bootstrap.consumeUrl and must be sent as one stdin line, never as argv or shell text.',
        credentialModeAfterBootstrap: 'local_proxy',
        projectOAuthRequired: false,
        exactUrlBehavior: 'Pass the exact clean mcpUrl with --exact-url so the installer never injects or changes scope.',
      },
      projectCreate: 'Creates a real Spala project through the authenticated platform API.',
      oauth: {
        protectedResourceMetadata: `${config.publicBaseUrl}/.well-known/oauth-protected-resource/mcp`,
        authorizationServerMetadata: `${config.publicBaseUrl}/.well-known/oauth-authorization-server/mcp`,
        authorizationEndpoint: `${config.publicBaseUrl}/oauth/authorize`,
        dashboardAuthorizationUrl: `${config.dashboardUrl}/mcp/authorize`,
        tokenEndpoint: `${config.publicBaseUrl}/oauth/token`,
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
        mcpUrl: 'https://returned-by-spala.example/mcp?scope=builder%2Cproject%2Cdata',
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

  server.registerTool('account_status', {
    description: TOOL_DESCRIPTIONS.accountStatus,
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: projectAuthMetadata(config),
  }, async () => {
    const auth = requireVerifiedPrincipal(ctx, api, 'account_status');
    if (typeof auth !== 'string') return auth;
    const principal = ctx.verifiedPrincipal!;
    const missingFields = missingAccountSetupFields(principal);
    const accountReady = missingFields.length === 0;
    return json({
      authenticated: true,
      tokenStatus: 'active',
      subject: principal.subject,
      user: principal.user,
      organizations: principal.organizations,
      accountSetup: {
        state: accountReady ? 'ready' : 'required',
        missingFields,
        nextTool: accountReady ? undefined : 'account_setup',
      },
      next: accountReady
        ? 'Ask for or confidently derive a real project name, then reuse .spala/project.json or call project_list before project_create.'
        : 'Ask the human one concise terminal question for exactly the missing account fields, then call account_setup. Do not use placeholders.',
    });
  });

  server.registerTool('account_setup', {
    description: TOOL_DESCRIPTIONS.accountSetup,
    inputSchema: {
      firstName: z.string().trim().min(1).max(120).optional(),
      lastName: z.string().trim().min(1).max(120).optional(),
      companyName: z.string().trim().min(1).max(120).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _meta: projectAuthMetadata(config),
  }, async (input) => {
    const auth = requireVerifiedPrincipal(ctx, api, 'account_setup');
    if (typeof auth !== 'string') return auth;
    const principal = ctx.verifiedPrincipal!;
    const missingFields = missingAccountSetupFields(principal);
    const stillMissing = missingFields.filter(field => !input[field]?.trim());
    if (stillMissing.length > 0) {
      return json({
        error: 'account_data_required',
        category: 'account_setup_required',
        message: 'Ask the human for the missing account data in one concise terminal question, then retry account_setup.',
        missingFields: stillMissing,
        action: { type: 'ask_human_for_account_data', fields: stillMissing },
        rule: 'Use real user-provided or explicitly known values. Do not invent placeholders.',
      }, true);
    }
    try {
      const setup = await withAccountSetupLock(principal.subject, () => api!.setupAccount(input));
      ctx.verifiedPrincipal = setup.principal;
      return json({
        accountSetup: 'complete',
        profileUpdated: setup.profileUpdated,
        organizationCreated: setup.organizationCreated,
        user: setup.principal.user,
        organization: setup.organization,
        next: 'Ask for or confidently derive the real project name, call project_list to avoid duplicates, then call project_create only when needed.',
      });
    } catch (error) {
      return safeProjectError(error, 'account_setup_failed', config);
    }
  });

  server.registerTool('project_list', {
    description: TOOL_DESCRIPTIONS.projectList,
    inputSchema: {
      organizationId: z.string().trim().min(1).max(256).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: projectAuthMetadata(config),
  }, async (input) => {
    const auth = requireVerifiedPrincipal(ctx, api, 'project_list');
    if (typeof auth !== 'string') return auth;
    try {
      return json(await api!.listProjects(input));
    } catch (error) {
      return safeProjectError(error, 'project_list_failed', config);
    }
  });

  server.registerTool('project_create', {
    description: TOOL_DESCRIPTIONS.projectCreate,
    inputSchema: {
      name: z.string().trim().min(1).max(120),
      organizationId: z.string().trim().min(1).max(256).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _meta: projectAuthMetadata(config),
  }, async (input) => {
    const auth = requireVerifiedPrincipal(ctx, api, 'project_create');
    if (typeof auth !== 'string') return auth;
    try {
      const created = await api!.createProject(input);
      return json({
        ...created,
        created: true,
        mcpUrlResolved: false,
        provisioning: {
          state: created.project.status,
          exactHandoffReady: false,
          message: 'Project creation completed, but an exact project MCP handoff is not ready yet.',
          retry: {
            tool: 'project_get_public_context',
            arguments: { projectId: created.project.id },
            instruction: 'Retry this read-only tool after provisioning completes. Do not construct a project MCP URL.',
          },
        },
        next: 'Call project_connect with the created project ID and one supported agentic workspace client (codex or roo). It will prepare MCP server-side when provisioning is ready.',
      });
    } catch (error) {
      return safeProjectError(error, 'project_create_failed', config);
    }
  });

  const connectProject = async (input: ProjectSelector, tool: 'project_connect' | 'project_select'): Promise<ToolResult> => {
    const selector = parseProjectSelector(input);
    if ('content' in selector) return selector;
    const auth = requireVerifiedPrincipal(ctx, api, tool);
    if (typeof auth !== 'string') return auth;
    const client = requireInstallClient(selector);
    if (typeof client !== 'string') return client;
    try {
      const resolved = await prepareHandoff(api!, selector, client);
      if (!resolved) return json({ error: 'project_not_found' }, true);
      const { handoff } = resolved;
      if (!handoff.mcpEnabled || !handoff.mcpUrl) {
        return json({
          error: 'project_mcp_not_ready',
          projectId: handoff.projectId,
          status: handoff.status,
          message: 'The authenticated project handoff completed, but the project MCP is not ready yet.',
          action: { type: 'retry_tool', tool, arguments: input },
        }, true);
      }
      const installPlan = projectMcpInstallPlan(handoff, client);
      const { bootstrapConsumeUrl: _bootstrapConsumeUrl, ...publicHandoff } = handoff;
      return json({
        project: resolved.project,
        handoff: publicHandoff,
        mcpUrl: handoff.mcpUrl,
        serverName: installPlan.serverName,
        transport: 'streamable-http',
        preparedByProjectBackend: true,
        bootstrapPreparedByProjectBackend: true,
        workspaceOnly: true,
        compatibilityAlias: tool === 'project_select' ? 'project_connect' : undefined,
        installPlan,
        bootstrap: {
          oneTime: true,
          immediateConsumptionRequired: true,
          consumeUrl: handoff.bootstrapConsumeUrl,
          input: 'stdin_single_line',
          exposedInInstallArgv: false,
          publicMcpFetchesUrl: false,
          projectOAuthRequired: false,
        },
        nextSteps: PROJECT_MCP_INSTALL_NEXT_STEPS,
        rule: 'Use this exact clean mcpUrl only in the bound workspace. Never guess the URL or install this project MCP globally.',
      });
    } catch (error) {
      return safeProjectError(error, `${tool}_failed`, config);
    }
  };

  server.registerTool('project_connect', {
    description: TOOL_DESCRIPTIONS.projectConnect,
    inputSchema: PROJECT_INSTALL_SELECTOR_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: projectAuthMetadata(config),
  }, async (input) => connectProject(input, 'project_connect'));

  server.registerTool('project_select', {
    description: TOOL_DESCRIPTIONS.projectSelect,
    inputSchema: PROJECT_INSTALL_SELECTOR_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: projectAuthMetadata(config),
  }, async (input) => connectProject(input, 'project_select'));

  server.registerTool('project_get_mcp_manifest', {
    description: TOOL_DESCRIPTIONS.projectManifest,
    inputSchema: PROJECT_INSTALL_SELECTOR_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: projectAuthMetadata(config),
  }, async (input) => {
    const selector = parseProjectSelector(input);
    if ('content' in selector) return selector;
    const auth = requireVerifiedPrincipal(ctx, api, 'project_get_mcp_manifest');
    if (typeof auth !== 'string') return auth;
    const client = requireInstallClient(selector);
    if (typeof client !== 'string') return client;
    try {
      const resolved = await prepareHandoff(api!, selector, client);
      if (!resolved) return json({ error: 'project_not_found' }, true);
      const { handoff } = resolved;
      if (!handoff.mcpEnabled || !handoff.mcpUrl || !handoff.manifestUrl) {
        return json({
          error: 'project_mcp_not_ready',
          projectId: handoff.projectId,
          status: handoff.status,
          action: { type: 'retry_tool', tool: 'project_get_mcp_manifest', arguments: input },
        }, true);
      }
      const installPlan = projectMcpInstallPlan(handoff, client);
      const { bootstrapConsumeUrl: _bootstrapConsumeUrl, ...publicHandoff } = handoff;
      return json({
        schemaVersion: 1,
        name: 'Spala Project MCP',
        project: resolved.project,
        handoff: publicHandoff,
        mcpUrl: handoff.mcpUrl,
        manifestUrl: handoff.manifestUrl,
        serverName: installPlan.serverName,
        transport: 'streamable-http',
        auth: 'local_credential_proxy_after_bootstrap',
        preparedByProjectBackend: true,
        bootstrapPreparedByProjectBackend: true,
        workspaceOnly: true,
        installPlan,
        bootstrap: {
          oneTime: true,
          immediateConsumptionRequired: true,
          consumeUrl: handoff.bootstrapConsumeUrl,
          input: 'stdin_single_line',
          exposedInInstallArgv: false,
          publicMcpFetchesUrl: false,
          projectOAuthRequired: false,
        },
        nextSteps: PROJECT_MCP_INSTALL_NEXT_STEPS,
        manifestNote: 'manifestUrl is informational. Do not fetch or pass a remote manifest to the installer; install with the exact mcpUrl in installPlan.argv.',
        rule: 'Use this exact mcpUrl for project MCP. Do not derive a URL from the project subdomain or host.',
      });
    } catch (error) {
      return safeProjectError(error, 'project_manifest_failed', config);
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
    const auth = requireVerifiedPrincipal(ctx, api, 'project_get_public_context');
    if (typeof auth !== 'string') return auth;
    try {
      const resolved = await resolveHandoff(api!, selector);
      if (!resolved) return json({ error: 'project_not_found' }, true);
      return json({
        project: resolved.project,
        handoff: {
          ...resolved.handoff,
          firstCalls: ['mcp_get_onboarding', 'mcp_get_tool_map', 'mcp_list_skills', 'mcp_get_skill({ name: "spala-developer" })', 'project_get_builder_context'],
        },
      });
    } catch (error) {
      return safeProjectError(error, 'project_context_failed', config);
    }
  });

  advertiseDirectoryQualityMetadata(server);
  return server;
}
