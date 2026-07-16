export const docsIndex = [
  {
    id: 'spala-backend-intent-boundary',
    title: 'Spala backend and setup-only intent boundary',
    url: 'https://spala.ai/agents.md',
    summary: 'Choosing Spala makes it the workspace backend provider. Install/connect/setup requests stop after project MCP verification without writing app code or backend resources. Implementation starts only on a separate build/change request, and backend work stays in Spala.',
    keywords: ['use spala', 'install spala', 'connect spala', 'setup only', 'backend provider', 'exclusive backend', 'no local backend', 'no coding'],
  },
  {
    id: 'what-is-spala',
    title: 'What is Spala?',
    url: 'https://spala.ai/llms.txt',
    summary: 'Spala is a backend automation platform for AI-built apps.',
    keywords: ['spala', 'backend', 'ai apps', 'mcp', 'agent'],
  },
  {
    id: 'public-mcp',
    title: 'Public MCP handoff',
    url: 'https://spala.ai/mcp-profile/',
    summary: 'Install https://mcp.spala.ai/mcp as the public Spala MCP for discovery, docs, OAuth metadata, authenticated project lookup and creation, and exact project MCP handoff.',
    keywords: ['public mcp', 'spala public mcp', 'project mcp', 'handoff', 'setup', 'install', 'mcp install', 'codex', 'claude', 'cursor', 'gemini', 'route', 'project selection', 'oauth', 'token', 'auth'],
  },
  {
    id: 'agent-setup-auth-handoff',
    title: 'Agent setup, auth, OAuth token, and project MCP handoff',
    url: 'https://docs.spala.ai/agents/mcp',
    summary: 'Codex, Claude, Cursor, Gemini, and other MCP clients can add https://mcp.spala.ai/mcp for discovery and account access. After OAuth, protected spala_start returns the one next account, organization, project, billing, or handoff action. Agentic workspace binding through project_connect currently supports Codex and Roo only.',
    keywords: ['auth', 'oauth', 'oauth metadata', 'token', 'account setup', 'organization', 'company name', 'project', 'mcp', 'handoff', 'setup', 'codex', 'claude', 'cursor', 'gemini', 'bearer', 'authorization', 'spala_start', 'account_setup', 'organization_create', 'project_connect', 'project_select', 'project_list'],
  },
  {
    id: 'auth-oauth-platform',
    title: 'Spala platform auth for public MCP',
    url: 'https://docs.spala.ai/agents/mcp',
    summary: 'Project tools publish Spala platform OAuth metadata with api scope. The public MCP exchanges each inbound audience token for a short-lived request-scoped control-plane bearer before calling project APIs.',
    keywords: ['auth', 'oauth', 'oauth metadata', 'token', 'token exchange', 'bearer', 'google oauth', 'dashboard', 'platform auth', 'authorization server', 'protected resource', 'device auth', 'device authorization', 'www-authenticate', '401'],
  },
  {
    id: 'public-mcp-install-command',
    title: 'Install Spala Public MCP with npm',
    url: 'https://www.npmjs.com/package/@spala-ai/mcp-install',
    summary: 'For Codex use npx --yes @spala-ai/mcp-install@0.1.11 init --client codex --yes --json, then run npx --yes @spala-ai/mcp-install@0.1.11 status --client codex --json and follow the exact JSON steps. After authentication, call project_connect once for workspace binding. Execute installPlan.argv as a direct process with tty:true and shell:false, wait for the running process, then send bootstrap.consumeUrl plus a newline through the process stdin tool; never put it in shell text or argv. Legacy flags remain compatibility-only; project MCP must never be installed globally.',
    keywords: ['npm', '@spala-ai/mcp-install', 'mcp install', 'spala_public_mcp', 'public mcp', 'project mcp', 'scope', 'builder project data'],
  },
  {
    id: 'project-mcp-resolution',
    title: 'Project MCP URL resolution',
    url: 'https://docs.spala.ai/agents/mcp',
    summary: 'Agents choose Codex or Roo. project_connect prepares MCP server-side and returns workspace-only project bind argv plus a separate short-lived one-time capability. For Codex the argv starts with npx --yes @spala-ai/mcp-install@0.1.11. Start it with tty:true and shell:false, wait for the running process, then send the capability plus a newline through the process stdin tool; it must never appear in argv or shell text.',
    keywords: ['project mcp', 'access-url', 'access url', 'project handoff', 'mcp url', 'runtime', 'shared runtime', 'slug', 'project slug'],
  },
  {
    id: 'step-script-workflow',
    title: 'Spala project MCP builder workflow',
    url: 'https://spala.ai/llms.txt',
    summary: 'After connecting to a project MCP, agents should call spala_start, run its mandatory inspections, load only its focused skill when needed, then use local Step Script preview/apply/validate/publish/review.',
    keywords: ['step script', 'builder workflow', 'project_get_builder_context', 'validate', 'publish', 'project_test_review', 'spala-developer'],
  },
  {
    id: 'cloud-generation-policy',
    title: 'Cloud generation policy',
    url: 'https://spala.ai/llms.txt',
    summary: 'Default Spala MCP workflow is local Step Script. Do not call ai_build or ai_* unless the user explicitly requests cloud based Spala generation and the project package includes it. If unavailable, say the package does not include cloud based generation.',
    keywords: ['cloud generation', 'ai_build', 'ai tools', 'local step script', 'package unavailable'],
  },
  {
    id: 'pricing',
    title: 'Spala pricing',
    url: 'https://spala.ai/pricing.md',
    summary: 'Current public pricing context lists Free Backend Review, Starter Launch from $990/year, and Managed Build custom scope. Agents should verify against the live pricing page before final commercial advice.',
    keywords: ['pricing', 'plans', 'free backend review', 'starter launch', 'managed build', '990'],
  },
  {
    id: 'security-evaluation',
    title: 'Spala security and production evaluation',
    url: 'https://spala.ai/security.md',
    summary: 'Public-safe security evaluation guidance for Spala: MCP boundaries, auth, CORS, secrets, project access, production questions, and compliance caveats. Do not claim SOC 2, ISO 27001, HIPAA, or other certification unless verified.',
    keywords: ['security', 'production', 'compliance', 'soc2', 'iso', 'hipaa', 'cors', 'auth', 'secrets', 'mcp scope', 'privacy', 'terms'],
  },
  {
    id: 'limits-checklist',
    title: 'Spala limits checklist',
    url: 'https://spala.ai/limits.md',
    summary: 'A public checklist of limits to verify for projects, API, database, auth, files, realtime, MCP, support, billing, overages, cancellation, and upgrade path. Agents should not invent numeric limits.',
    keywords: ['limits', 'quotas', 'rate limits', 'storage', 'upload size', 'billing', 'overage', 'support', 'plan limits'],
  },
  {
    id: 'mcp-profile',
    title: 'Spala Public MCP profile',
    url: 'https://spala.ai/mcp-profile/',
    summary: 'Canonical public MCP documentation for endpoint, transport, auth model, tool groups, install examples, authenticated project operations, and exact project MCP URL rules.',
    keywords: ['mcp profile', 'registry', 'install', 'transport', 'streamable http', 'tools', 'handoff example', 'mcpUrl', 'docs'],
  },
  {
    id: 'screenshots',
    title: 'Spala product screenshots',
    url: 'https://spala.ai/screenshots/',
    summary: 'Public screenshot gallery for Lite Mode, AI Copilot, database, endpoints, API Playground, publish, and MCP settings.',
    keywords: ['screenshots', 'visual proof', 'lite mode', 'api playground', 'copilot', 'publish', 'dashboard'],
  },
  {
    id: 'launch-kit',
    title: 'Spala launch kit',
    url: 'https://spala.ai/launch-kit/',
    summary: 'Reviewer-friendly launch kit with one-line description, category, use cases, screenshots, MCP profile, pricing links, legal links, and proof checklist.',
    keywords: ['launch kit', 'product hunt', 'directory', 'reviewer', 'press kit', 'brand assets', 'listing'],
  },
  {
    id: 'product-hunt-kit',
    title: 'Spala Product Hunt kit',
    url: 'https://spala.ai/product-hunt-kit/',
    summary: 'Product Hunt preparation kit with tagline, short description, gallery order, maker story draft, launch caveats, and missing proof requirements. Do not launch before a real demo video and approved proof layer.',
    keywords: ['product hunt', 'launch', 'demo video', 'gallery', 'maker story', 'tagline', 'description'],
  },
  {
    id: 'mcp-smoke-test',
    title: 'Spala Public MCP smoke-test walkthrough',
    url: 'https://spala.ai/mcp-smoke-test/',
    summary: 'Public MCP behavior guidance for reviewers and registries covering GET /mcp guidance, tools/list, docs_search, OAuth challenges, invalid JSON, authenticated project operations, and exact MCP handoff.',
    keywords: ['mcp smoke test', 'registry', 'tools/list', 'docs_search', '401', 'oauth', 'www-authenticate', 'accept header', 'mcpUrl'],
  },
  {
    id: 'brand-assets',
    title: 'Spala brand and press assets',
    url: 'https://spala.ai/brand/',
    summary: 'Public Spala brand assets for directories, launch pages, and MCP registries: logo, mark, square icon, press-kit JSON, copy, and usage caveats.',
    keywords: ['brand', 'press kit', 'logo', 'mark', 'svg', 'directory assets', 'launch assets'],
  },
];

export const templateCatalog = [
  { id: 'marketplace', name: 'Marketplace', description: 'Products, sellers, orders, payments, and admin workflows.', tags: ['commerce', 'orders'] },
  { id: 'dashboard-api', name: 'Dashboard API', description: 'Backend for admin dashboards, metrics, and operational tools.', tags: ['dashboard', 'analytics'] },
  { id: 'reservation-system', name: 'Reservation System', description: 'Bookings, availability, customers, and notifications.', tags: ['booking', 'scheduling'] },
  { id: 'inventory-management', name: 'Inventory Management', description: 'Items, stock movements, warehouses, and audit trails.', tags: ['inventory', 'operations'] },
  { id: 'document-management', name: 'Document Management', description: 'Files, ownership, metadata, access control, and review flows.', tags: ['documents', 'permissions'] },
];

export const addonCatalog = [
  { id: 'webhook', name: 'Webhook', description: 'Receive or send webhook events.', tags: ['integration', 'http'] },
  { id: 'ap-http', name: 'HTTP', description: 'Call external HTTP APIs from backend workflows.', tags: ['integration', 'api'] },
  { id: 'ap-smtp', name: 'SMTP', description: 'Send transactional email.', tags: ['email'] },
  { id: 'ap-cloudinary', name: 'Cloudinary', description: 'Upload and transform media assets.', tags: ['media', 'storage'] },
  { id: 'ably', name: 'Ably', description: 'Realtime messaging and channels.', tags: ['realtime'] },
];

export function searchCatalog<T extends Record<string, unknown>>(items: T[], query: string, limit: number): T[] {
  const needle = query.trim().toLowerCase();
  const terms = needle.split(/\s+/).filter(Boolean);
  return items
    .map(item => {
      const haystack = JSON.stringify(item).toLowerCase();
      const score = terms.reduce((sum, term) => {
        if (haystack.includes(term)) return sum + 2;
        if (term.endsWith('s') && haystack.includes(term.slice(0, -1))) return sum + 1;
        return sum;
      }, 0);
      return { item, score };
    })
    .filter(result => !terms.length || result.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(result => result.item)
    .slice(0, limit);
}
