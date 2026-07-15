import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { createSpalaPublicMcpServer, SUPPORTED_INSTALL_CLIENTS } from '../src/mcp.js';
import { SpalaApiError, type SpalaApiClient, type SpalaPrincipal } from '../src/spalaApi.js';

const config = loadConfig({
  PUBLIC_BASE_URL: 'https://mcp.spala.ai',
  SPALA_API_BASE_URL: 'https://api.spala.ai',
  PUBLIC_OAUTH_ENCRYPTION_SECRET: 'test-public-oauth-encryption-secret-32-bytes',
  PUBLIC_OAUTH_REPLAY_STATE_PATH: '/tmp/mcp-spala-ai-mcp-test-replay',
  SPALA_DASHBOARD_URL: 'https://dashboard.spala.ai',
  SPALA_PRICING_URL: 'https://spala.ai/pricing/',
});

const principal: SpalaPrincipal = {
  subject: 'test-user',
  user: { id: 'test-user', email: 'user@example.test', firstName: 'Test', lastName: 'User' },
  organizations: [{ id: 'org-1', name: 'Test organization' }],
};

const project = {
  id: 'project-1',
  name: 'Project One',
  status: 'ready',
  subdomain: 'project-one',
  organizationId: 'org-1',
};

const handoff = {
  projectId: 'project-1',
  projectName: 'Project One',
  status: 'ready',
  projectUrl: 'https://project-one.example',
  mcpEnabled: true,
  mcpUrl: 'https://shared-runtime.example/tenant/project-1/mcp/?scope=builder,project,data',
  manifestUrl: 'https://manifests.example/exact/project-1.json',
  bootstrapConsumeUrl: 'https://project-one.example/mcp/bootstrap?session=opaque-session-secret',
};

function apiStub(overrides: Partial<SpalaApiClient> = {}): SpalaApiClient {
  return {
    async getPrincipal() { return principal; },
    async setupAccount() {
      return {
        principal,
        organization: principal.organizations[0]!,
        profileUpdated: false,
        organizationCreated: false,
      };
    },
    async listProjects() { return { organization: principal.organizations[0]!, projects: [project] }; },
    async createProject(input) {
      return {
        organization: principal.organizations[0]!,
        project: { ...project, id: 'project-created', name: input.name, subdomain: 'project-created' },
      };
    },
    async getProjectHandoff() { return handoff; },
    async prepareProjectMcp() { return handoff; },
    ...overrides,
  };
}

async function withVerifiedClient<T>(
  api: SpalaApiClient,
  run: (client: Client) => Promise<T>,
  verifiedPrincipal: SpalaPrincipal = principal,
): Promise<T> {
  const server = createSpalaPublicMcpServer(config, api, { verifiedPrincipal });
  const client = new Client({ name: 'mcp-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const item = result.content[0];
  assert.ok(item && item.type === 'text');
  return item.text;
}

function resultJson(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  return JSON.parse(resultText(result)) as Record<string, unknown>;
}

test('tools/list advertises authenticated status and honest project preparation mutations', async () => {
  await withVerifiedClient(apiStub(), async client => {
    const { tools } = await client.listTools();
    const start = tools.find(candidate => candidate.name === 'spala_start');
    assert.ok(start);
    assert.deepEqual(start.inputSchema, {
      type: 'object',
      description: 'No arguments. Call this tool with an empty object.',
      properties: {},
      additionalProperties: false,
    });
    assert.deepEqual(start.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.match(start.description || '', /MANDATORY FIRST CALL/i);
    assert.match(start.description || '', /before reading application files.*frontend or design skills.*coding.*testing.*QA/i);

    const account = tools.find(candidate => candidate.name === 'account_status');
    assert.ok(account);
    assert.equal(account.annotations?.readOnlyHint, true);
    assert.deepEqual(account._meta?.['securitySchemes'], [{ type: 'oauth2', scopes: ['api'] }]);

    const accountSetup = tools.find(candidate => candidate.name === 'account_setup');
    assert.ok(accountSetup);
    assert.equal(accountSetup.annotations?.readOnlyHint, false);
    assert.equal(accountSetup.annotations?.idempotentHint, false);
    assert.deepEqual(Object.keys(accountSetup.inputSchema.properties || {}).sort(), ['companyName', 'firstName', 'lastName']);

    for (const name of ['project_connect', 'project_select', 'project_get_mcp_manifest', 'project_get_public_context']) {
      const tool = tools.find(candidate => candidate.name === name);
      assert.ok(tool, name);
      const installs = name !== 'project_get_public_context';
      assert.deepEqual(
        Object.keys(tool.inputSchema.properties || {}).sort(),
        installs ? ['client', 'organizationId', 'projectId', 'subdomain'] : ['organizationId', 'projectId', 'subdomain'],
      );
      if (installs) {
        assert.deepEqual(
          (tool.inputSchema.properties?.['client'] as { enum: string[] }).enum,
          SUPPORTED_INSTALL_CLIENTS,
        );
      }
      assert.equal(Array.isArray(tool.inputSchema.oneOf), true);
      assert.deepEqual(
        (tool.inputSchema.oneOf as Array<{ required: string[] }>).map(branch => branch.required).sort(),
        [['projectId'], ['subdomain']],
      );
      const projectIdBranch = (tool.inputSchema.oneOf as Array<{
        required: string[];
        properties: Record<string, unknown>;
      }>).find(branch => branch.required.includes('projectId'));
      assert.ok(projectIdBranch);
      assert.equal('organizationId' in projectIdBranch.properties, false);
      assert.deepEqual(tool._meta?.['securitySchemes'], [{ type: 'oauth2', scopes: ['api'] }]);
      assert.deepEqual(tool._meta?.['spala.ai/auth'], {
        required: true,
        tokenValidation: 'Secure server-side validation and request-scoped delegation.',
        available: true,
        missingBearerBehavior: 'HTTP 401 with WWW-Authenticate OAuth challenge',
        invalidBearerBehavior: 'HTTP 401 with WWW-Authenticate OAuth challenge',
        insufficientScopeBehavior: 'HTTP 403 with WWW-Authenticate insufficient_scope challenge',
        upstreamUnavailableBehavior: 'HTTP 503 with a generic error',
        protectedResourceMetadata: 'https://mcp.spala.ai/.well-known/oauth-protected-resource/mcp',
        authorizationServerMetadata: 'https://mcp.spala.ai/.well-known/oauth-authorization-server/mcp',
        authorizationEndpoint: 'https://mcp.spala.ai/oauth/authorize',
        dashboardAuthorizationUrl: 'https://dashboard.spala.ai/mcp/authorize',
      });
      assert.equal(tool.annotations?.readOnlyHint, name === 'project_get_public_context');
      assert.equal(tool.annotations?.idempotentHint, true);
    }

    const create = tools.find(candidate => candidate.name === 'project_create');
    assert.ok(create);
    assert.equal(create.annotations?.readOnlyHint, false);
    assert.equal(create.annotations?.idempotentHint, false);
    assert.match(create.description || '', /writes to the spala control plane/i);
    assert.deepEqual(Object.keys(create.inputSchema.properties || {}).sort(), ['name', 'organizationId']);
  });
});

test('spala_start establishes Spala and blocks application work until project MCP readiness', async () => {
  await withVerifiedClient(apiStub(), async client => {
    const result = await client.callTool({ name: 'spala_start', arguments: {} });
    assert.notEqual(result.isError, true);
    const body = resultJson(result);
    assert.equal(body.triggered, true);
    assert.equal(body.backendProvider, 'Spala');
    assert.deepEqual(body.setupGate, {
      state: 'blocked_until_project_mcp_ready',
      requiredNextTool: 'account_status',
      requiredSequence: ['account_status', 'account_setup when required', 'project_list or project_create', 'project_connect', 'verify project MCP'],
      prohibitedUntilResolved: [
        'inspect application source',
        'plan application implementation',
        'generate a design concept',
        'scaffold or write frontend code',
        'create or mutate backend resources',
        'run application tests or visual QA',
      ],
    });
    assert.match(String(body.next), /Call account_status now/i);
    assert.match(String(body.next), /frontend\/design.*plan.*designs.*scaffold.*code.*test.*QA/i);
  });
});

test('tool map publishes spala_start as anonymous discovery and the first capability', async () => {
  await withVerifiedClient(apiStub(), async client => {
    const body = resultJson(await client.callTool({ name: 'spala_get_tool_map', arguments: {} }));
    const publicMcp = body.publicMcp as { tools: { discovery: string[] }; toolCapabilities: Array<Record<string, unknown>> };
    assert.deepEqual(publicMcp.tools.discovery, [
      'spala_start',
      'spala_help',
      'spala_get_onboarding',
      'spala_get_tool_map',
      'docs_search',
      'template_list',
      'addon_list',
    ]);
    assert.deepEqual(publicMcp.toolCapabilities[0], {
      name: 'spala_start',
      requiresAuth: false,
      effect: 'read',
      purpose: 'Mandatory first call whenever the user mentions using Spala. Establishes the backend-provider choice and blocks all application work until account setup and project MCP verification complete.',
    });
    assert.equal((body.publicMcp as Record<string, unknown>).authRequiredTools instanceof Array, true);
    assert.equal(((body.publicMcp as Record<string, unknown>).authRequiredTools as string[]).includes('spala_start'), false);
  });
});

test('install tools require client selection before preparation while public context remains client-free', async () => {
  let handoffCalls = 0;
  let prepareCalls = 0;
  const api = apiStub({
    async getProjectHandoff() {
      handoffCalls += 1;
      return handoff;
    },
    async prepareProjectMcp() {
      prepareCalls += 1;
      return handoff;
    },
  });

  await withVerifiedClient(api, async client => {
    for (const name of ['project_connect', 'project_select', 'project_get_mcp_manifest']) {
      const result = await client.callTool({ name, arguments: { projectId: 'project-1' } });
      assert.equal(result.isError, true);
      const body = resultJson(result);
      assert.equal(body.error, 'client_selection_required');
      assert.deepEqual(body.supportedClients, SUPPORTED_INSTALL_CLIENTS);
      assert.deepEqual(body.action, { type: 'select_client', argument: 'client' });
      assert.equal('installPlan' in body, false);
    }
    assert.equal(prepareCalls, 0);
    assert.equal(handoffCalls, 0);

    const context = await client.callTool({
      name: 'project_get_public_context',
      arguments: { projectId: 'project-1' },
    });
    assert.notEqual(context.isError, true);
    assert.equal('installPlan' in resultJson(context), false);
    assert.equal(handoffCalls, 1);
  });
});

test('project selectors enforce exactly one field before API access', async () => {
  let listCalls = 0;
  const api = apiStub({
    async listProjects() {
      listCalls += 1;
      return { organization: principal.organizations[0]!, projects: [project] };
    },
  });

  await withVerifiedClient(api, async client => {
    for (const args of [{}, { projectId: 'p1', subdomain: 'one' }]) {
      const result = await client.callTool({ name: 'project_select', arguments: args });
      assert.equal(result.isError, true);
      assert.match(resultText(result), /exactly one of projectId or subdomain/i);
    }
    const ignoredOrganization = await client.callTool({
      name: 'project_select',
      arguments: { projectId: 'p1', organizationId: 'org-1', client: 'codex' },
    });
    assert.equal(ignoredOrganization.isError, true);
    assert.match(resultText(ignoredOrganization), /organizationId is allowed only with subdomain/i);
    assert.equal(listCalls, 0);
  });
});

test('unscoped prepared handoffs produce workspace-only project bind plans without URL mutation', async () => {
  const unscopedMcpUrl = 'https://shared-runtime.example/tenant/project-1/mcp/';
  let prepareCalls = 0;
  const api = apiStub({
    async prepareProjectMcp() {
      prepareCalls += 1;
      return { ...handoff, mcpUrl: unscopedMcpUrl };
    },
  });

  await withVerifiedClient(api, async client => {
    for (const name of ['project_connect', 'project_select', 'project_get_mcp_manifest']) {
      const result = await client.callTool({
        name,
        arguments: { projectId: 'project-1', client: 'codex' },
      });
      assert.notEqual(result.isError, true);
      const body = resultJson(result);
      assert.equal(body.mcpUrl, unscopedMcpUrl);
      const plan = body.installPlan as Record<string, unknown> & { argv: string[] };
      assert.deepEqual(plan.argv.slice(0, 5), ['npx', '--yes', '@spala-ai/mcp-install@0.1.11', 'project', 'bind']);
      assert.equal(plan.argv[plan.argv.indexOf('--url') + 1], unscopedMcpUrl);
      assert.equal(plan.argv[plan.argv.indexOf('--project-id') + 1], 'project-1');
      assert.equal(plan.argv[plan.argv.indexOf('--project-url') + 1], handoff.projectUrl);
      assert.equal(plan.argv[plan.argv.indexOf('--client') + 1], 'codex');
      assert.equal(plan.argv[plan.argv.indexOf('--install-scope') + 1], 'workspace');
      assert.equal(plan.argv.includes('--bootstrap-stdin'), true);
      assert.equal(plan.argv.includes('--bootstrap-url'), false);
      assert.equal(plan.argv.includes(handoff.bootstrapConsumeUrl), false);
      assert.equal((body.bootstrap as { consumeUrl: string }).consumeUrl, handoff.bootstrapConsumeUrl);
      assert.equal(plan.workspaceOnly, true);
      assert.equal(plan.globalInstall, false);
      assert.equal(plan.bindingFile, '.spala/project.json');
      assert.deepEqual(plan.execution, {
        method: 'process',
        shell: false,
        tty: true,
        waitForRunningProcess: true,
        stdin: {
          tool: 'process_stdin',
          processSource: 'running_process',
          valueSource: 'bootstrap.consumeUrl',
          appendNewline: true,
          shell: false,
          argv: false,
        },
        sequence: [
          { order: 1, action: 'start_process', argvSource: 'installPlan.argv', shell: false, tty: true },
          { order: 2, action: 'wait_for_running_process', required: true },
          {
            order: 3,
            action: 'send_process_stdin',
            tool: 'process_stdin',
            processSource: 'running_process',
            valueSource: 'bootstrap.consumeUrl',
            appendNewline: true,
          },
        ],
      });
      assert.doesNotMatch(plan.argv.join(' '), /--scope user|--scope global/);
    }
    assert.equal(prepareCalls, 3);
  });
});

test('project_list and project_create use authoritative organization inputs and report a real write', async () => {
  const received: Array<unknown> = [];
  const api = apiStub({
    async listProjects(input) {
      received.push({ operation: 'list', input });
      return { organization: principal.organizations[0]!, projects: [project] };
    },
    async createProject(input) {
      received.push({ operation: 'create', input });
      return {
        organization: principal.organizations[0]!,
        project: { ...project, id: 'project-created', name: input.name, subdomain: 'created' },
      };
    },
  });

  await withVerifiedClient(api, async client => {
    const listed = await client.callTool({ name: 'project_list', arguments: { organizationId: 'org-1' } });
    assert.notEqual(listed.isError, true);
    assert.equal((resultJson(listed).organization as { id: string }).id, 'org-1');

    const created = await client.callTool({
      name: 'project_create',
      arguments: { name: '  Real Project  ', organizationId: 'org-1' },
    });
    assert.notEqual(created.isError, true);
    assert.equal(resultJson(created).created, true);
    assert.deepEqual(resultJson(created).provisioning, {
      state: 'ready',
      exactHandoffReady: false,
      message: 'Project creation completed, but an exact project MCP handoff is not ready yet.',
      retry: {
        tool: 'project_get_public_context',
        arguments: { projectId: 'project-created' },
        instruction: 'Retry this read-only tool after provisioning completes. Do not construct a project MCP URL.',
      },
    });
    assert.deepEqual(received, [
      { operation: 'list', input: { organizationId: 'org-1' } },
      { operation: 'create', input: { name: 'Real Project', organizationId: 'org-1' } },
    ]);

    const oversized = await client.callTool({
      name: 'project_create',
      arguments: { name: 'x'.repeat(121) },
    });
    assert.equal(oversized.isError, true);
    assert.match(resultText(oversized), /120|too big|too long/i);
  });
});

test('project_connect, compatibility select, and manifest send the client and keep bootstrap capabilities out of argv', async () => {
  const calls: string[] = [];
  const api = apiStub({
    async listProjects(input) {
      calls.push(`list:${input?.organizationId || ''}`);
      return { organization: principal.organizations[0]!, projects: [project] };
    },
    async prepareProjectMcp(projectId, client) {
      calls.push(`prepare:${projectId}:${client}`);
      return handoff;
    },
  });

  await withVerifiedClient(api, async client => {
    const connected = await client.callTool({
      name: 'project_connect',
      arguments: { subdomain: 'project-one', organizationId: 'org-1', client: 'codex' },
    });
    assert.notEqual(connected.isError, true);
    const connectedBody = resultJson(connected);
    assert.equal(connectedBody.mcpUrl, handoff.mcpUrl);
    assert.equal(connectedBody.preparedByProjectBackend, true);
    assert.equal(connectedBody.bootstrapPreparedByProjectBackend, true);
    assert.equal(connectedBody.workspaceOnly, true);
    const connectPlan = connectedBody.installPlan as Record<string, unknown> & { argv: string[] };
    assert.deepEqual(connectPlan.argv.slice(0, 5), ['npx', '--yes', '@spala-ai/mcp-install@0.1.11', 'project', 'bind']);
    assert.equal(connectPlan.argv[connectPlan.argv.indexOf('--url') + 1], handoff.mcpUrl);
    assert.equal(connectPlan.argv[connectPlan.argv.indexOf('--name') + 1], connectedBody.serverName);
    assert.equal(connectPlan.argv.includes('--bootstrap-stdin'), true);
    assert.equal(connectPlan.argv.includes('--bootstrap-url'), false);
    assert.equal(connectPlan.argv.includes(handoff.bootstrapConsumeUrl), false);
    assert.equal(connectPlan.shell, false);
    assert.equal(connectPlan.remoteManifestFetch, false);
    assert.equal(connectPlan.globalInstall, false);
    assert.equal(connectPlan.projectOAuthRequired, false);
    assert.deepEqual((connectPlan.execution as Record<string, unknown>).stdin, {
      tool: 'process_stdin',
      processSource: 'running_process',
      valueSource: 'bootstrap.consumeUrl',
      appendNewline: true,
      shell: false,
      argv: false,
    });
    assert.equal((connectPlan.execution as Record<string, unknown>).shell, false);
    assert.equal((connectPlan.execution as Record<string, unknown>).tty, true);
    assert.equal((connectPlan.execution as Record<string, unknown>).waitForRunningProcess, true);
    assert.equal((connectedBody.handoff as Record<string, unknown>).bootstrapConsumeUrl, undefined);
    assert.deepEqual(connectedBody.bootstrap, {
      oneTime: true,
      immediateConsumptionRequired: true,
      consumeUrl: handoff.bootstrapConsumeUrl,
      input: 'stdin_single_line',
      exposedInInstallArgv: false,
      publicMcpFetchesUrl: false,
      projectOAuthRequired: false,
    });
    const nextSteps = (connectedBody.nextSteps as string[]).join('\n');
    assert.match(nextSteps, /\.spala\/project\.json.*not install.*globally/i);
    assert.match(nextSteps, /installPlan\.argv immediately/i);
    assert.match(nextSteps, /process stdin tool.*bootstrap\.consumeUrl/i);
    assert.match(nextSteps, /Never place it in shell text or argv/i);
    assert.match(nextSteps, /local credential proxy/i);
    assert.match(nextSteps, /Do not start native or manual project OAuth/i);
    assert.match(nextSteps, /Do not store, inspect, print, or reuse/i);
    assert.equal(JSON.stringify(connectedBody).split('opaque-session-secret').length - 1, 1);

    const selected = await client.callTool({
      name: 'project_select',
      arguments: { projectId: 'project-1', client: 'codex' },
    });
    assert.notEqual(selected.isError, true);
    assert.equal(resultJson(selected).compatibilityAlias, 'project_connect');

    const manifest = await client.callTool({
      name: 'project_get_mcp_manifest',
      arguments: { projectId: 'project-1', client: 'roo' },
    });
    assert.notEqual(manifest.isError, true);
    const manifestBody = resultJson(manifest);
    assert.equal(manifestBody.mcpUrl, handoff.mcpUrl);
    assert.equal(manifestBody.manifestUrl, handoff.manifestUrl);
    const manifestArgv = (manifestBody.installPlan as { argv: string[] }).argv;
    assert.deepEqual(manifestArgv.slice(0, 5), ['pnpm', 'dlx', '@spala-ai/mcp-install@0.1.11', 'project', 'bind']);
    assert.equal(manifestArgv[manifestArgv.indexOf('--client') + 1], 'roo');
    assert.equal(manifestArgv[manifestArgv.indexOf('--install-scope') + 1], 'workspace');
    assert.equal(manifestArgv.includes('--bootstrap-stdin'), true);
    assert.equal(manifestArgv.includes('--bootstrap-url'), false);
    assert.equal(manifestArgv.includes(handoff.bootstrapConsumeUrl), false);
    assert.equal(manifestArgv.includes(handoff.manifestUrl), false);
    assert.match(String(manifestBody.manifestNote), /informational.*Do not fetch/i);
    assert.deepEqual(calls, [
      'list:org-1',
      'prepare:project-1:codex',
      'list:org-1',
      'prepare:project-1:codex',
      'list:org-1',
      'prepare:project-1:roo',
    ]);
  });
});

test('raw project IDs are verified against every request-principal organization before project preparation', async () => {
  const accountA: SpalaPrincipal = {
    subject: 'account-a',
    user: { id: 'account-a', email: 'account-a@example.test' },
    organizations: [
      { id: 'org-a-1', name: 'Account A first organization' },
      { id: 'org-a-2', name: 'Account A second organization' },
    ],
  };
  const accountB: SpalaPrincipal = {
    subject: 'account-b',
    user: { id: 'account-b', email: 'account-b@example.test' },
    organizations: [{ id: 'org-b', name: 'Account B organization' }],
  };
  const accountAProject = { ...project, id: 'project-a', organizationId: 'org-a-2' };
  const accountBProject = { ...project, id: 'project-b', organizationId: 'org-b' };
  const calls: string[] = [];
  const api = apiStub({
    async listProjects(input) {
      const organizationId = input?.organizationId;
      calls.push(`list:${organizationId}`);
      const projectsByOrganization: Record<string, typeof project[]> = {
        'org-a-1': [],
        'org-a-2': [accountAProject],
        'org-b': [accountBProject],
      };
      return {
        organization: { id: organizationId!, name: `Organization ${organizationId}` },
        projects: projectsByOrganization[organizationId!] || [],
      };
    },
    async prepareProjectMcp(projectId, client) {
      calls.push(`prepare:${projectId}:${client}`);
      return { ...handoff, projectId, projectName: projectId };
    },
    async getProjectHandoff(projectId) {
      calls.push(`handoff:${projectId}`);
      return { ...handoff, projectId, projectName: projectId };
    },
  });

  await withVerifiedClient(api, async client => {
    for (const name of ['project_connect', 'project_select', 'project_get_mcp_manifest']) {
      const result = await client.callTool({ name, arguments: { projectId: 'project-b', client: 'codex' } });
      assert.equal(result.isError, true, name);
      assert.equal(resultJson(result).error, 'project_not_found', name);
    }
    const publicContext = await client.callTool({
      name: 'project_get_public_context',
      arguments: { projectId: 'project-b' },
    });
    assert.equal(publicContext.isError, true);
    assert.equal(resultJson(publicContext).error, 'project_not_found');
  }, accountA);
  assert.deepEqual(calls, [
    'list:org-a-1', 'list:org-a-2',
    'list:org-a-1', 'list:org-a-2',
    'list:org-a-1', 'list:org-a-2',
    'list:org-a-1', 'list:org-a-2',
  ]);
  assert.equal(
    calls.some(call => call.startsWith('handoff:')),
    false,
    'foreign IDs must not call getProjectHandoff',
  );
  assert.equal(
    calls.some(call => call.startsWith('prepare:')),
    false,
    'foreign IDs must not call getProjectAccessUrl or the project backend through prepareProjectMcp',
  );

  await withVerifiedClient(api, async client => {
    const result = await client.callTool({
      name: 'project_connect',
      arguments: { projectId: 'project-a', client: 'codex' },
    });
    assert.notEqual(result.isError, true);
  }, accountA);
  assert.deepEqual(calls.slice(-3), ['list:org-a-1', 'list:org-a-2', 'prepare:project-a:codex']);

  await withVerifiedClient(api, async client => {
    const result = await client.callTool({
      name: 'project_connect',
      arguments: { projectId: 'project-b', client: 'codex' },
    });
    assert.notEqual(result.isError, true);
  }, accountB);
  assert.deepEqual(calls.slice(-2), ['list:org-b', 'prepare:project-b:codex']);
});

test('account_status reports only request-verified identity state', async () => {
  await withVerifiedClient(apiStub(), async client => {
    const result = await client.callTool({ name: 'account_status', arguments: {} });
    assert.notEqual(result.isError, true);
    assert.deepEqual(resultJson(result), {
      authenticated: true,
      tokenStatus: 'active',
      subject: 'test-user',
      user: { id: 'test-user', email: 'user@example.test', firstName: 'Test', lastName: 'User' },
      organizations: [{ id: 'org-1', name: 'Test organization' }],
      accountSetup: { state: 'ready', missingFields: [] },
      next: 'Ask for or confidently derive a real project name, then reuse .spala/project.json or call project_list before project_create.',
    });
  });
});

test('incomplete accounts report exact fields and setup creates the first organization', async () => {
  const incomplete: SpalaPrincipal = {
    subject: 'new-user',
    user: { id: 'new-user', email: 'new@example.test' },
    organizations: [],
  };
  const completed: SpalaPrincipal = {
    ...incomplete,
    user: { ...incomplete.user, firstName: 'Ada', lastName: 'Lovelace' },
    organizations: [{ id: 'org-new', name: 'Analytical Apps' }],
  };
  const setupInputs: unknown[] = [];
  const api = apiStub({
    async getPrincipal() { return incomplete; },
    async setupAccount(input) {
      setupInputs.push(input);
      return {
        principal: completed,
        organization: completed.organizations[0]!,
        profileUpdated: true,
        organizationCreated: true,
      };
    },
  });

  await withVerifiedClient(api, async client => {
    const status = resultJson(await client.callTool({ name: 'account_status', arguments: {} }));
    assert.deepEqual(status.accountSetup, {
      state: 'required',
      missingFields: ['firstName', 'lastName', 'companyName'],
      nextTool: 'account_setup',
    });
    assert.equal(status.blocked, true);
    assert.deepEqual(status.gate, {
      state: 'blocked',
      reason: 'account_setup_required',
      missingFields: ['firstName', 'lastName', 'companyName'],
      requiredNextAction: 'ask_human_then_call_account_setup',
      nextAssistantResponse: 'Ask one concise terminal question for exactly missingFields, then wait for the answer. Do not include implementation progress or offer to continue other work.',
      prohibitedUntilResolved: [
        'inspect application source',
        'plan application implementation',
        'generate a design concept',
        'scaffold or write frontend code',
        'create or mutate backend resources',
        'run application tests or visual QA',
      ],
    });
    assert.match(String(status.next), /ask.*missing account fields.*wait/i);
    assert.match(JSON.stringify(status.gate), /frontend|design|coding|QA/i);

    const incompleteSetup = await client.callTool({
      name: 'account_setup',
      arguments: { firstName: 'Ada' },
    });
    assert.equal(incompleteSetup.isError, true);
    const incompleteSetupBody = resultJson(incompleteSetup);
    assert.deepEqual(incompleteSetupBody.missingFields, ['lastName', 'companyName']);
    assert.equal(incompleteSetupBody.blocked, true);
    assert.equal((incompleteSetupBody.gate as { reason: string }).reason, 'account_setup_required');
    assert.deepEqual((incompleteSetupBody.gate as { missingFields: string[] }).missingFields, ['lastName', 'companyName']);
    assert.match(String((incompleteSetupBody.gate as { nextAssistantResponse: string }).nextAssistantResponse), /ask.*then wait/i);
    assert.match(JSON.stringify((incompleteSetupBody.gate as { prohibitedUntilResolved: string[] }).prohibitedUntilResolved), /frontend|design|coding|QA/i);
    assert.equal(setupInputs.length, 0);

    const setup = await client.callTool({
      name: 'account_setup',
      arguments: { firstName: 'Ada', lastName: 'Lovelace', companyName: 'Analytical Apps' },
    });
    assert.notEqual(setup.isError, true);
    assert.equal(resultJson(setup).accountSetup, 'complete');
    assert.equal(resultJson(setup).organizationCreated, true);
    assert.deepEqual(setupInputs, [{ firstName: 'Ada', lastName: 'Lovelace', companyName: 'Analytical Apps' }]);
  }, incomplete);
});

test('project_connect retries without dashboard dependency when preparation is not ready', async () => {
  await withVerifiedClient(apiStub({
    async prepareProjectMcp() {
      return { ...handoff, status: 'provisioning', mcpEnabled: false, mcpUrl: undefined, manifestUrl: undefined };
    },
  }), async client => {
    const result = await client.callTool({
      name: 'project_connect',
      arguments: { projectId: 'project-1', client: 'codex' },
    });
    assert.equal(result.isError, true);
    const body = resultJson(result);
    assert.equal(body.error, 'project_mcp_not_ready');
    assert.deepEqual(body.action, {
      type: 'retry_tool',
      tool: 'project_connect',
      arguments: { projectId: 'project-1', client: 'codex' },
    });
    assert.doesNotMatch(JSON.stringify(body), /dashboard|bootstrapConsumeUrl|opaque-session-secret/i);
  });
});

test('plan and payment failures include dashboard/pricing actions without inventing checkout URLs', async () => {
  const api = apiStub({
    async createProject() {
      throw new SpalaApiError({
        category: 'plan_restricted',
        status: 403,
        code: 'free_plan_restricted',
        message: 'Upgrade required.',
      });
    },
  });

  await withVerifiedClient(api, async client => {
    const result = await client.callTool({ name: 'project_create', arguments: { name: 'Paid Project' } });
    assert.equal(result.isError, true);
    const body = resultJson(result);
    assert.equal(body.error, 'free_plan_restricted');
    assert.deepEqual(body.action, {
      type: 'human_payment_required',
      dashboardUrl: 'https://dashboard.spala.ai',
      pricingUrl: 'https://spala.ai/pricing',
    });
    assert.match(resultText(result), /stop and ask the human/i);
    assert.doesNotMatch(resultText(result), /checkout/i);
  });
});
