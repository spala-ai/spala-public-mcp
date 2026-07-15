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
      assert.deepEqual(plan.argv.slice(0, 5), ['pnpm', 'dlx', '@spala-ai/mcp-install@0.1.8', 'project', 'bind']);
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
    assert.deepEqual(connectPlan.argv.slice(0, 5), ['pnpm', 'dlx', '@spala-ai/mcp-install@0.1.8', 'project', 'bind']);
    assert.equal(connectPlan.argv[connectPlan.argv.indexOf('--url') + 1], handoff.mcpUrl);
    assert.equal(connectPlan.argv[connectPlan.argv.indexOf('--name') + 1], connectedBody.serverName);
    assert.equal(connectPlan.argv.includes('--bootstrap-stdin'), true);
    assert.equal(connectPlan.argv.includes('--bootstrap-url'), false);
    assert.equal(connectPlan.argv.includes(handoff.bootstrapConsumeUrl), false);
    assert.equal(connectPlan.shell, false);
    assert.equal(connectPlan.remoteManifestFetch, false);
    assert.equal(connectPlan.globalInstall, false);
    assert.equal(connectPlan.projectOAuthRequired, false);
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
    assert.match((connectedBody.nextSteps as string[])[1] || '', /\.spala\/project\.json.*not install.*globally/i);
    const nextSteps = (connectedBody.nextSteps as string[]).join('\n');
    assert.match(nextSteps, /installPlan\.argv immediately/i);
    assert.match(nextSteps, /bootstrap\.consumeUrl.*stdin/i);
    assert.match(nextSteps, /Never interpolate it into a shell command/i);
    assert.match(nextSteps, /local credential proxy/i);
    assert.match(nextSteps, /Do not start native or manual project OAuth/i);
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
    assert.deepEqual(manifestArgv.slice(0, 5), ['pnpm', 'dlx', '@spala-ai/mcp-install@0.1.8', 'project', 'bind']);
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
      'prepare:project-1:codex',
      'prepare:project-1:roo',
    ]);
  });
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

    const incompleteSetup = await client.callTool({
      name: 'account_setup',
      arguments: { firstName: 'Ada' },
    });
    assert.equal(incompleteSetup.isError, true);
    assert.deepEqual(resultJson(incompleteSetup).missingFields, ['lastName', 'companyName']);
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
