import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import {
  createSpalaApiClient as createDelegatedSpalaApiClient,
  parseProjectHandoff,
  parseProjectMcpUrl,
  parseProjectRecord,
  SpalaApiError,
} from '../src/spalaApi.js';
import { publicMcpPlatformContract } from './fixtures/publicMcpPlatformContract.js';

function createSpalaApiClient(
  configValue: Parameters<typeof createDelegatedSpalaApiClient>[0],
  platformAccessToken: string,
  fetchImpl: Parameters<typeof createDelegatedSpalaApiClient>[2],
) {
  return createDelegatedSpalaApiClient(configValue, {
    platformAccessToken,
    clientHash: 'a'.repeat(64),
  }, fetchImpl);
}

const config = loadConfig({
  PUBLIC_BASE_URL: 'https://mcp.spala.ai',
  SPALA_API_BASE_URL: 'https://control.spala.example',
  PUBLIC_OAUTH_ENCRYPTION_SECRET: 'test-public-oauth-encryption-secret-32-bytes',
  PUBLIC_MCP_PLATFORM_SERVICE_SECRET: 'test-public-mcp-platform-service-secret-32-bytes',
  PUBLIC_MCP_TRUSTED_SHARED_RUNTIME_ORIGINS: 'https://shared-runtime.example',
  PUBLIC_OAUTH_REPLAY_STATE_PATH: '/tmp/mcp-spala-ai-api-test-replay',
  SPALA_DASHBOARD_URL: 'https://dashboard.spala.ai',
  SPALA_PRICING_URL: 'https://spala.ai/pricing/',
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fetchStub(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    return handler(url, init || {});
  }) as typeof fetch;
}

function projectMcpHandoff(projectUrl = 'https://project.example'): Record<string, unknown> {
  return {
    projectId: 'project-1',
    projectName: 'Project One',
    status: 'ready',
    projectUrl,
    mcpEnabled: true,
    mcpUrl: `${projectUrl}/mcp`,
    manifestUrl: `${projectUrl}/mcp/install-manifest`,
  };
}

function projectAccessUrl(projectUrl: string, token: string): Record<string, unknown> {
  const encodedProjectUrl = Buffer.from(projectUrl).toString('base64');
  return {
    url: `https://app.spala.ai/?url=${encodeURIComponent(encodedProjectUrl)}&auth_token=${token}`,
  };
}

function agentInstructionSession(
  consumeUrl: unknown,
  scope = 'builder,project,data',
  deliveryMode: unknown = 'one-time',
): Response {
  return jsonResponse({
    consumeUrl,
    scopes: scope.split(','),
    deliveryMode,
  }, 201);
}

test('parseProjectMcpUrl accepts only explicit public HTTPS MCP endpoints', () => {
  assert.equal(parseProjectMcpUrl('https://project.example/mcp'), 'https://project.example/mcp');
  assert.equal(parseProjectMcpUrl('https://shared.example/project-a/mcp/'), 'https://shared.example/project-a/mcp/');
  const rawCommaScope = 'https://shared.example/project-a/mcp/?scope=builder,project,data';
  const encodedCommaScope = 'https://shared.example/project-a/mcp/?scope=builder%2Cproject%2Cdata';
  const encodedSubsetScope = 'https://shared.example/project-a/mcp/?scope=builder%2Cproject';
  assert.equal(parseProjectMcpUrl(rawCommaScope), rawCommaScope);
  assert.equal(parseProjectMcpUrl(encodedCommaScope), encodedCommaScope);
  assert.equal(parseProjectMcpUrl(encodedSubsetScope), encodedSubsetScope);
  assert.equal(
    parseProjectMcpUrl('https://project.example/mcp?scope=builder&scope=project'),
    undefined,
    'duplicate scope parameters must be rejected',
  );

  for (const value of [
    'http://project.example/mcp',
    'https://user:secret@project.example/mcp',
    'https://project.example/mcp?token=secret',
    'https://project.example/mcp?scope=builder&token=secret',
    'https://project.example/mcp?scope=',
    'https://project.example/mcp?scope=api',
    'https://project.example/mcp?scope=builder,builder',
    'https://project.example/mcp#secret',
    'https://PROJECT.example/mcp?scope=builder,project,data',
    'https://project.example:443/mcp?scope=builder,project,data',
    'https://project.example/api',
    'https://127.0.0.1/mcp',
    'https://10.0.0.4/mcp',
    'https://[::]/mcp',
    'https://[::1]/mcp',
    'https://[fe80::1]/mcp',
    'https://[fc00::1]/mcp',
    'https://[fd00::1]/mcp',
    'https://[::ffff:127.0.0.1]/mcp',
    'https://[::ffff:10.0.0.1]/mcp',
    'https://[::ffff:169.254.1.1]/mcp',
    'https://[::ffff:192.168.1.1]/mcp',
    'https://project.example/a/../mcp',
    'https://project.example/a/%2e%2e/mcp',
    'javascript:alert(1)',
  ]) {
    assert.equal(parseProjectMcpUrl(value), undefined, value);
  }
});

test('project and handoff parsers accept only documented fields', () => {
  assert.deepEqual(parseProjectRecord({
    id: 'project-1',
    project_name: 'Project One',
    status: 'ready',
    subdomain: 'project-one',
    mcpUrl: 'https://ignored.example/mcp',
  }), {
    id: 'project-1',
    name: 'Project One',
    status: 'ready',
    subdomain: 'project-one',
  });
  assert.equal(parseProjectRecord({
    id: 'project-1',
    name: 'Wrong field',
    status: 'ready',
    subdomain: 'project-one',
    nested: { project_name: 'Nested' },
  }), undefined);

  const handoff = {
    projectId: 'project-1',
    projectName: 'Project One',
    status: 'ready',
    projectUrl: 'https://project-one.example',
    mcpEnabled: true,
    mcpUrl: 'https://runtime.example/project-1/mcp',
    manifestUrl: 'https://runtime.example/project-1/manifest.json',
  };
  assert.deepEqual(parseProjectHandoff(handoff), handoff);
  const scopedManifest = {
    ...handoff,
    manifestUrl: 'https://runtime.example/project-1/manifest.json?scope=builder%2Cproject%2Cdata',
  };
  assert.deepEqual(parseProjectHandoff(scopedManifest), scopedManifest);
  assert.equal(parseProjectHandoff({ ...handoff, mcpUrl: 'https://runtime.example/project-1' }), undefined);
  assert.equal(parseProjectHandoff({ ...handoff, manifestUrl: 'http://runtime.example/manifest.json' }), undefined);
});

test('platform operation fixture matches principal, project, handoff, and access-url contracts', async () => {
  const fixture = publicMcpPlatformContract;
  assert.deepEqual(Object.keys(fixture.principal), fixture.responseFields.principal);
  assert.deepEqual(Object.keys(fixture.projects.projects[0]), fixture.responseFields.project);
  assert.deepEqual(Object.keys(fixture.handoff), fixture.responseFields.handoff);
  assert.deepEqual(Object.keys(fixture.accessUrl), fixture.responseFields.accessUrl);

  const api = createSpalaApiClient(config, 'contract-public-access-token', fetchStub((url, init) => {
    if (url.pathname === '/api/__internal/public-mcp/v1/principal') {
      return jsonResponse(fixture.principal);
    }
    if (url.pathname === '/api/__internal/public-mcp/v1/projects' && init.method === 'GET') {
      return jsonResponse(fixture.projects);
    }
    if (url.pathname.endsWith('/mcp-handoff')) {
      return jsonResponse(fixture.handoff);
    }
    if (url.pathname.endsWith('/access-url')) {
      return jsonResponse(fixture.accessUrl);
    }
    if (url.pathname === '/api/__internal/builder-auth/external-handoff/resolve') {
      assert.deepEqual(JSON.parse(String(init.body)), { handoff: fixture.externalAuthHandoff });
      return jsonResponse({ backend: fixture.projectUrl });
    }
    if (url.origin === fixture.projectUrl && url.pathname === '/api/__internal/builder-auth/external') {
      return jsonResponse({ token: fixture.builderToken });
    }
    if (url.origin === fixture.projectUrl && url.pathname === '/api/__internal/project/config') {
      return jsonResponse({ success: true });
    }
    if (url.origin === fixture.projectUrl && url.pathname === '/mcp/agent-instructions') {
      return agentInstructionSession(
        `${fixture.projectUrl}/mcp/agent-instructions/mcp_agent_contract/consume`,
      );
    }
    return jsonResponse({ error: 'unexpected_request' }, 500);
  }));

  const principal = await api.getPrincipal();
  assert.equal(principal.subject, fixture.principal.user.id);
  const projects = await api.listProjects({ organizationId: fixture.principal.organizations[0].id });
  assert.equal(projects.projects[0]?.id, fixture.projects.projects[0].id);
  const handoff = await api.getProjectHandoff(fixture.handoff.projectId);
  assert.deepEqual(handoff, fixture.handoff);
  const prepared = await api.prepareProjectMcp(fixture.handoff.projectId, 'codex');
  assert.equal(prepared.bootstrapConsumeUrl, `${fixture.projectUrl}/mcp/agent-instructions/mcp_agent_contract/consume`);
  assert.doesNotMatch(
    JSON.stringify([principal, projects, handoff, prepared]),
    new RegExp(fixture.projectAccessToken),
  );
});

test('Claude Code preparation skips the one-time instruction session used by bootstrap clients', async () => {
  const projectUrl = 'https://project.example';
  const projectToken = 'temporary-project-token';
  const builderToken = 'builder-project-token';
  const projectCalls: string[] = [];
  const api = createSpalaApiClient(config, 'opaque-public-mcp-access', fetchStub((url, init) => {
    if (url.pathname.endsWith('/mcp-handoff')) {
      return jsonResponse(projectMcpHandoff(projectUrl));
    }
    if (url.pathname.endsWith('/access-url')) {
      return jsonResponse(projectAccessUrl(projectUrl, projectToken));
    }
    if (url.origin === projectUrl) projectCalls.push(`${init.method || 'GET'} ${url.pathname}`);
    if (url.origin === projectUrl && url.pathname === '/api/__internal/builder-auth/external') {
      return jsonResponse({ token: builderToken });
    }
    if (url.origin === projectUrl && url.pathname === '/api/__internal/project/config') {
      return jsonResponse({ success: true });
    }
    if (url.origin === projectUrl && url.pathname === '/mcp/agent-instructions') {
      return jsonResponse({ error: 'must_not_be_called' }, 500);
    }
    return jsonResponse({ error: 'unexpected_request' }, 500);
  }));

  const prepared = await api.prepareProjectMcp('project-1', 'claude-code');

  assert.equal(prepared.mcpUrl, `${projectUrl}/mcp?scope=builder%2Cproject%2Cdata`);
  assert.equal(prepared.bootstrapConsumeUrl, undefined);
  assert.deepEqual(projectCalls, [
    'POST /api/__internal/builder-auth/external',
    'POST /api/__internal/project/config',
  ]);
});

test('Claude Code preparation binds its delegated claim to the local installer challenge', async () => {
  const projectUrl = 'https://project.example';
  const projectToken = 'temporary-project-token';
  const builderToken = 'builder-project-token';
  const challenge = 'c'.repeat(43);
  let instructionBody: Record<string, unknown> | undefined;
  const api = createSpalaApiClient(config, 'opaque-public-mcp-access', fetchStub((url, init) => {
    if (url.pathname.endsWith('/mcp-handoff')) return jsonResponse(projectMcpHandoff(projectUrl));
    if (url.pathname.endsWith('/access-url')) return jsonResponse(projectAccessUrl(projectUrl, projectToken));
    if (url.origin === projectUrl && url.pathname === '/api/__internal/builder-auth/external') {
      return jsonResponse({ token: builderToken });
    }
    if (url.origin === projectUrl && url.pathname === '/api/__internal/project/config') {
      return jsonResponse({ success: true });
    }
    if (url.origin === projectUrl && url.pathname === '/mcp/agent-instructions') {
      instructionBody = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
      return jsonResponse({
        consumeUrl: `${projectUrl}/mcp/agent-instructions/mcp_agent_pkce/consume`,
        scopes: ['builder', 'project', 'data'],
        deliveryMode: 'one-time-pkce',
      }, 201);
    }
    return jsonResponse({ error: 'unexpected_request' }, 500);
  }));

  const prepared = await api.prepareProjectMcp('project-1', 'claude-code', {
    requestId: `claim_${'r'.repeat(24)}`,
    challenge,
  });

  assert.equal(prepared.bootstrapConsumeUrl, `${projectUrl}/mcp/agent-instructions/mcp_agent_pkce/consume`);
  assert.deepEqual(instructionBody, {
    scope: 'builder,project,data',
    clientName: 'Spala claude-code agent',
    deliveryMode: 'one-time-pkce',
    codeChallenge: challenge,
  });
});

test('signed external-auth handoff resolves the backend and consumes its one-time token once', async () => {
  const projectUrl = 'https://project.example';
  const externalAuthHandoff = 'signed-external-auth-handoff-value';
  const projectToken = 'temporary-project-token';
  const builderToken = 'builder-project-token';
  const projectCalls: string[] = [];
  const api = createSpalaApiClient(config, 'opaque-public-mcp-access', fetchStub((url, init) => {
    if (url.pathname.endsWith('/mcp-handoff')) {
      return jsonResponse(projectMcpHandoff(projectUrl));
    }
    if (url.pathname.endsWith('/access-url')) {
      return jsonResponse({
        url: `https://app.spala.ai/?handoff=${externalAuthHandoff}&auth_token=${projectToken}`,
      });
    }
    if (url.pathname === '/api/__internal/builder-auth/external-handoff/resolve') {
      assert.deepEqual(JSON.parse(String(init.body)), { handoff: externalAuthHandoff });
      return jsonResponse({ backend: projectUrl });
    }
    if (url.origin === projectUrl && url.pathname === '/api/__internal/builder-auth/external') {
      projectCalls.push(url.pathname);
      if (projectCalls.length > 1) {
        return jsonResponse({ error: 'token_already_used' }, 401);
      }
      assert.deepEqual(JSON.parse(String(init.body)), { token: projectToken });
      return jsonResponse({ token: builderToken });
    }
    if (url.origin === projectUrl && url.pathname === '/api/__internal/project/config') {
      return jsonResponse({ success: true });
    }
    if (url.origin === projectUrl && url.pathname === '/mcp/agent-instructions') {
      return agentInstructionSession(
        `${projectUrl}/mcp/agent-instructions/mcp_agent_signed_handoff/consume`,
      );
    }
    return jsonResponse({ error: 'unexpected_request' }, 500);
  }));

  const prepared = await api.prepareProjectMcp('project-1', 'codex');
  assert.equal(prepared.projectUrl, projectUrl);
  assert.deepEqual(projectCalls, ['/api/__internal/builder-auth/external']);
  assert.doesNotMatch(JSON.stringify(prepared), new RegExp(`${externalAuthHandoff}|${projectToken}|${builderToken}`));
});

test('signed external-auth handoff rejects a backend that differs from the authoritative project', async () => {
  const externalAuthHandoff = 'signed-external-auth-handoff-value';
  const api = createSpalaApiClient(config, 'opaque-public-mcp-access', fetchStub((url) => {
    if (url.pathname.endsWith('/mcp-handoff')) {
      return jsonResponse(projectMcpHandoff('https://project.example'));
    }
    if (url.pathname.endsWith('/access-url')) {
      return jsonResponse({
        url: `https://app.spala.ai/?handoff=${externalAuthHandoff}&auth_token=temporary-project-token`,
      });
    }
    if (url.pathname === '/api/__internal/builder-auth/external-handoff/resolve') {
      return jsonResponse({ backend: 'https://other-project.example' });
    }
    return jsonResponse({ error: 'project request must not run' }, 500);
  }));

  await assert.rejects(api.prepareProjectMcp('project-1', 'codex'), (error: unknown) => {
    assert.ok(error instanceof SpalaApiError);
    assert.equal(error.category, 'invalid_upstream_response');
    assert.equal(error.code, 'invalid_project_access_handoff');
    assert.doesNotMatch(error.message, new RegExp(externalAuthHandoff));
    return true;
  });
});

test('project handoff rejects unresolved template placeholders in every URL component', () => {
  const handoff = {
    projectId: 'project-1',
    projectName: 'One',
    status: 'ready',
    projectUrl: 'https://project.example',
    mcpEnabled: true,
    mcpUrl: 'https://project.example/mcp',
    manifestUrl: 'https://project.example/mcp/install-manifest',
  };

  for (const projectUrl of [
    'https://api.spala.ai/{{project}}',
    'https://api.spala.ai/%7B%7Bproject%7D%7D',
    'https://api.spala.ai/%25%37%42%25%37%42project%25%37%44%25%37%44',
    'https://{{project}}.spala.ai',
    'https://%7B%7Bproject%7D%7D.spala.ai',
  ]) {
    assert.equal(parseProjectHandoff({ ...handoff, projectUrl }), undefined);
  }
  for (const mcpUrl of [
    'https://api.spala.ai/{{project}}/mcp',
    'https://api.spala.ai/%7B%7Bproject%7D%7D/mcp',
    'https://api.spala.ai/%25%37%42%25%37%42project%25%37%44%25%37%44/mcp',
    'https://{{project}}.spala.ai/mcp',
    'https://%7B%7Bproject%7D%7D.spala.ai/mcp',
  ]) {
    assert.equal(parseProjectHandoff({ ...handoff, mcpUrl }), undefined);
  }
  for (const manifestUrl of [
    'https://api.spala.ai/{{project}}/mcp/install-manifest',
    'https://api.spala.ai/%7B%7Bproject%7D%7D/mcp/install-manifest',
    'https://api.spala.ai/%25%37%42%25%37%42project%25%37%44%25%37%44/mcp/install-manifest',
    'https://{{project}}.spala.ai/mcp/install-manifest',
    'https://%7B%7Bproject%7D%7D.spala.ai/mcp/install-manifest',
  ]) {
    assert.equal(parseProjectHandoff({ ...handoff, manifestUrl }), undefined);
  }
});

test('authenticated client reuses the first builder session when the project and MCP runtime match', async () => {
  const token = 'opaque-valid-token';
  const projectToken = 'temporary-project-token';
  const builderToken = 'builder-project-token';
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const api = createSpalaApiClient(config, token, fetchStub((url, init) => {
    calls.push({ url, init });
    if (url.pathname === '/api/__internal/public-mcp/v1/principal') {
      return jsonResponse({
        user: { id: 'user-1', email: 'user@example.test' },
        organizations: [{ id: 'org-1', name: 'First' }, { id: 'org-2', name: 'Second' }],
      });
    }
    if (url.pathname === '/api/__internal/public-mcp/v1/projects' && init.method === 'GET') {
      return jsonResponse({ projects: [{ id: 'project-1', project_name: 'One', status: 'ready', subdomain: 'one' }] });
    }
    if (url.pathname === '/api/__internal/public-mcp/v1/projects' && init.method === 'POST') {
      return jsonResponse({ project: { id: 'project-2', project_name: 'Created', status: 'creating', subdomain: 'created' } }, 201);
    }
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') {
      return jsonResponse({
        projectId: 'project-1',
        projectName: 'One',
        status: 'ready',
        projectUrl: 'https://one.example',
        mcpEnabled: true,
        mcpUrl: 'https://one.example/mcp',
        manifestUrl: 'https://one.example/mcp/install-manifest',
      });
    }
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url' && init.method === 'GET') {
      return jsonResponse(projectAccessUrl('https://one.example', projectToken));
    }
    if (url.origin === 'https://one.example' && url.pathname === '/api/__internal/builder-auth/external' && init.method === 'POST') {
      return jsonResponse({ token: builderToken });
    }
    if (url.origin === 'https://one.example' && url.pathname === '/api/__internal/project/config' && init.method === 'POST') {
      return jsonResponse({ success: true });
    }
    if (url.origin === 'https://one.example' && url.pathname === '/mcp/agent-instructions' && init.method === 'POST') {
      return agentInstructionSession(
        'https://one.example/mcp/agent-instructions/mcp_agent_test/consume',
      );
    }
    return jsonResponse({ error: 'not_found' }, 404);
  }));

  const principal = await api.getPrincipal();
  assert.equal(principal.subject, 'user-1');
  assert.strictEqual(await api.getPrincipal(), principal);

  for (const operation of [
    () => api.listProjects(),
    () => api.createProject({ name: 'Must choose' }),
  ]) {
    await assert.rejects(operation(), (error: unknown) => {
      assert.ok(error instanceof SpalaApiError);
      assert.equal(error.category, 'organization_selection_required');
      assert.equal(error.code, 'organization_selection_required');
      assert.deepEqual(error.organizationChoices, [
        { id: 'org-1', name: 'First' },
        { id: 'org-2', name: 'Second' },
      ]);
      return true;
    });
  }
  assert.equal(calls.length, 1, 'ambiguous organization must not issue a project API request');

  const listed = await api.listProjects({ organizationId: 'org-1' });
  assert.equal(listed.organization.id, 'org-1');
  assert.deepEqual(listed.projects[0], {
    id: 'project-1', name: 'One', status: 'ready', subdomain: 'one', organizationId: 'org-1',
  });

  const created = await api.createProject({ name: '  Created  ', organizationId: 'org-2' });
  assert.equal(created.organization.id, 'org-2');
  assert.equal(created.project.organizationId, 'org-2');

  const handoff = await api.getProjectHandoff('project-1');
  assert.equal(handoff.mcpUrl, 'https://one.example/mcp');
  assert.equal(handoff.manifestUrl, 'https://one.example/mcp/install-manifest');

  const prepared = await api.prepareProjectMcp('project-1', 'codex');
  assert.equal(prepared.projectId, 'project-1');
  assert.equal(prepared.mcpEnabled, true);
  assert.equal(prepared.mcpUrl, 'https://one.example/mcp?scope=builder%2Cproject%2Cdata');
  assert.equal(prepared.manifestUrl, 'https://one.example/mcp/install-manifest?scope=builder%2Cproject%2Cdata');
  assert.equal(prepared.bootstrapConsumeUrl, 'https://one.example/mcp/agent-instructions/mcp_agent_test/consume');

  assert.equal(calls.filter(call => call.url.pathname === '/api/__internal/public-mcp/v1/principal').length, 1);
  assert.equal(calls.find(call => call.init.method === 'GET' && call.url.pathname === '/api/__internal/public-mcp/v1/projects')?.url.search, '?organizationId=org-1');
  const createCall = calls.find(call => call.init.method === 'POST' && call.url.pathname === '/api/__internal/public-mcp/v1/projects');
  assert.equal(createCall?.init.body, JSON.stringify({ project_name: 'Created', organization_id: 'org-2' }));
  assert.equal(calls.some(call => call.url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp/prepare'), false);
  const controlCalls = calls.filter(call => call.url.origin === 'https://control.spala.example');
  const projectCalls = calls.filter(call => call.url.origin === 'https://one.example');
  for (const call of controlCalls) {
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.cache, 'no-store');
    assert.doesNotMatch(call.url.toString(), /opaque-valid-token/);
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get('authorization'), `Bearer ${token}`);
    assert.equal(headers.get('x-spala-public-mcp-service-secret'), config.publicMcpPlatformServiceSecret);
    assert.equal(headers.get('content-type'), call.init.method === 'POST' ? 'application/json' : null);
    assert.equal([...headers.keys()].length, call.init.method === 'POST' ? 3 : 2);
    assert.doesNotMatch(String(call.init.body || ''), /opaque-valid-token/);
  }
  assert.deepEqual(projectCalls.map(call => `${call.init.method} ${call.url.pathname}`), [
    'POST /api/__internal/builder-auth/external',
    'POST /api/__internal/project/config',
    'POST /mcp/agent-instructions',
  ]);
  const exchangeCall = projectCalls[0]!;
  assert.equal(new Headers(exchangeCall.init.headers).get('authorization'), null);
  assert.equal(new Headers(exchangeCall.init.headers).get('x-spala-public-mcp-service-secret'), null);
  assert.equal(exchangeCall.init.body, JSON.stringify({ token: projectToken }));
  assert.doesNotMatch(String(exchangeCall.init.body), /opaque-valid-token/);
  assert.equal(projectCalls.some(call => call.init.method === 'POST' && call.url.pathname === '/api/__internal/project/config'), true);
  assert.equal(projectCalls[1]?.init.body, JSON.stringify({
    securityConfig: { mcpEnabled: true },
  }));
  assert.equal(projectCalls[2]?.init.body, JSON.stringify({
    scope: 'builder,project,data',
    clientName: 'Spala codex agent',
    deliveryMode: 'one-time',
  }));
  for (const call of projectCalls.slice(1)) {
    assert.equal(new Headers(call.init.headers).get('authorization'), `Bearer ${builderToken}`);
    assert.doesNotMatch(call.url.toString(), new RegExp(`${projectToken}|${builderToken}`));
    assert.doesNotMatch(String(call.init.body || ''), new RegExp(`${projectToken}|${builderToken}`));
  }
  assert.doesNotMatch(JSON.stringify(prepared), /opaque-valid-token|temporary-project-token|builder-project-token/);
});

test('project preparation trusts the exact custom-domain access origin and path', async () => {
  const projectUrl = 'https://backend.customer.example/apps/project-one';
  const projectToken = 'custom-domain-project-entry-token';
  const builderToken = 'custom-domain-builder-token';
  const projectCalls: URL[] = [];
  const api = createSpalaApiClient(config, 'custom-domain-public-access', fetchStub((url) => {
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') {
      return jsonResponse(projectMcpHandoff(projectUrl));
    }
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url') {
      return jsonResponse(projectAccessUrl(projectUrl, projectToken));
    }
    if (url.origin === new URL(projectUrl).origin) {
      projectCalls.push(url);
      if (url.pathname === '/apps/project-one/api/__internal/builder-auth/external') {
        return jsonResponse({ token: builderToken });
      }
      if (url.pathname === '/apps/project-one/api/__internal/project/config') {
        return jsonResponse({ success: true });
      }
      if (url.pathname === '/apps/project-one/mcp/agent-instructions') {
        return agentInstructionSession(
          `${projectUrl}/mcp/agent-instructions/mcp_agent_custom_domain/consume`,
        );
      }
    }
    return jsonResponse({ error: 'unexpected_request' }, 500);
  }));

  const prepared = await api.prepareProjectMcp('project-1', 'codex');

  assert.equal(prepared.projectUrl, projectUrl);
  assert.equal(prepared.mcpUrl, `${projectUrl}/mcp?scope=builder%2Cproject%2Cdata`);
  assert.equal(
    prepared.bootstrapConsumeUrl,
    `${projectUrl}/mcp/agent-instructions/mcp_agent_custom_domain/consume`,
  );
  assert.deepEqual(projectCalls.map(url => url.pathname), [
    '/apps/project-one/api/__internal/builder-auth/external',
    '/apps/project-one/api/__internal/project/config',
    '/apps/project-one/mcp/agent-instructions',
  ]);
});

test('project preparation rejects untrusted or malformed shared runtimes before runtime token exchange', async () => {
  const projectUrl = 'https://project.example';
  const projectToken = 'untrusted-runtime-project-entry-token';
  const builderToken = 'untrusted-runtime-builder-token';

  for (const fixture of [
    {
      label: 'unconfigured origin',
      runtimeUrl: 'https://untrusted-runtime.example/p123/mcp',
      clientConfig: { ...config, publicMcpTrustedSharedRuntimeOrigins: [] },
    },
    {
      label: 'unconfigured subdomain',
      runtimeUrl: 'https://tenant.shared-runtime.example/p123/mcp',
      clientConfig: config,
    },
    {
      label: 'invalid shared mount path',
      runtimeUrl: 'https://shared-runtime.example/tenant/p123/mcp',
      clientConfig: config,
    },
    {
      label: 'reserved shared mount path',
      runtimeUrl: 'https://shared-runtime.example/api/mcp',
      clientConfig: config,
    },
  ]) {
    const calls: URL[] = [];
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const api = createSpalaApiClient(
        fixture.clientConfig,
        'untrusted-runtime-public-access-token',
        fetchStub((url) => {
          calls.push(url);
          if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') {
            return jsonResponse({
              ...projectMcpHandoff(projectUrl),
              mcpUrl: fixture.runtimeUrl,
              manifestUrl: `${fixture.runtimeUrl}/install-manifest`,
            });
          }
          if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url') {
            return jsonResponse(projectAccessUrl(projectUrl, projectToken));
          }
          if (url.origin === projectUrl && url.pathname === '/api/__internal/builder-auth/external') {
            return jsonResponse({ token: builderToken });
          }
          if (url.origin === projectUrl && url.pathname === '/api/__internal/project/config') {
            return jsonResponse({ success: true });
          }
          return jsonResponse({ error: 'runtime exchange must not be reached' }, 500);
        }),
      );

      await assert.rejects(api.prepareProjectMcp('project-1', 'codex'), (error: unknown) => {
        assert.ok(error instanceof SpalaApiError);
        assert.equal(error.category, 'invalid_upstream_response', fixture.label);
        assert.equal(error.code, 'invalid_project_bootstrap_material', fixture.label);
        assert.doesNotMatch(
          error.message,
          /untrusted-runtime|shared-runtime|project-entry-token|builder-token/,
          fixture.label,
        );
        return true;
      });
    } finally {
      console.warn = originalWarn;
    }

    const runtimeOrigin = new URL(fixture.runtimeUrl).origin;
    assert.equal(
      calls.some(url => url.origin === runtimeOrigin),
      false,
      `${fixture.label} must fail before POSTing the reusable project token`,
    );
    assert.doesNotMatch(
      JSON.stringify(warnings),
      /untrusted-runtime|shared-runtime|project-entry-token|builder-token/,
      fixture.label,
    );
  }
});

test('project preparation preserves authoritative handoff URLs instead of deriving them from projectUrl', async () => {
  const projectToken = 'temporary-authoritative-url-token';
  const builderToken = 'builder-authoritative-url-token';
  const runtimeBuilderToken = 'builder-authoritative-runtime-token';
  const projectUrl = 'https://project.example';
  const authorizedScope = 'builder,project';
  const authoritativeMcpUrl = 'https://shared-runtime.example/p123/mcp/?scope=builder%2Cproject';
  const authoritativeManifestUrl = 'https://shared-runtime.example/p123/mcp/install-manifest?scope=builder%2Cproject';
  const requestOrder: string[] = [];
  let instructionRequest: Record<string, unknown> | undefined;
  let instructionUrl: string | undefined;
  let instructionAuthorization: string | null | undefined;
  const api = createSpalaApiClient(config, 'opaque-public-mcp-access', fetchStub((url, init) => {
    requestOrder.push(`${init.method || 'GET'} ${url.origin}${url.pathname}`);
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') {
      return jsonResponse({
        projectId: 'project-1',
        projectName: 'One',
        status: 'ready',
        projectUrl,
        mcpEnabled: true,
        mcpUrl: authoritativeMcpUrl,
        manifestUrl: authoritativeManifestUrl,
      });
    }
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url') {
      return jsonResponse(projectAccessUrl(projectUrl, projectToken));
    }
    if (url.origin === projectUrl && url.pathname === '/api/__internal/builder-auth/external') {
      return jsonResponse({ token: builderToken });
    }
    if (url.origin === projectUrl && url.pathname === '/api/__internal/project/config') {
      return jsonResponse({ success: true });
    }
    if (
      url.origin === 'https://shared-runtime.example'
      && url.pathname === '/p123/api/__internal/builder-auth/external'
    ) {
      assert.equal(new Headers(init.headers).get('authorization'), null);
      assert.equal(init.body, JSON.stringify({ token: projectToken }));
      return jsonResponse({ token: runtimeBuilderToken });
    }
    if (
      url.origin === 'https://shared-runtime.example'
      && url.pathname === '/p123/api/__internal/project/config'
    ) {
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${runtimeBuilderToken}`);
      return jsonResponse({ success: true });
    }
    if (
      url.origin === 'https://shared-runtime.example'
      && url.pathname === '/p123/mcp/agent-instructions'
    ) {
      instructionUrl = url.toString();
      instructionAuthorization = new Headers(init.headers).get('authorization');
      instructionRequest = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
      return agentInstructionSession(
        'https://shared-runtime.example/p123/mcp/agent-instructions/mcp_agent_authoritative/consume',
        authorizedScope,
      );
    }
    return jsonResponse({ error: 'unexpected_request' }, 500);
  }));

  const prepared = await api.prepareProjectMcp('project-1', 'codex');

  assert.equal(prepared.mcpUrl, authoritativeMcpUrl);
  assert.equal(prepared.manifestUrl, authoritativeManifestUrl);
  assert.equal(
    prepared.bootstrapConsumeUrl,
    'https://shared-runtime.example/p123/mcp/agent-instructions/mcp_agent_authoritative/consume',
  );
  assert.equal(instructionUrl, 'https://shared-runtime.example/p123/mcp/agent-instructions');
  assert.equal(instructionAuthorization, `Bearer ${runtimeBuilderToken}`);
  assert.notEqual(instructionAuthorization, `Bearer ${builderToken}`);
  assert.equal(instructionRequest?.['scope'], authorizedScope);
  assert.deepEqual(requestOrder, [
    'GET https://control.spala.example/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff',
    'GET https://control.spala.example/api/__internal/public-mcp/v1/projects/project-1/access-url',
    'POST https://shared-runtime.example/p123/api/__internal/builder-auth/external',
    'POST https://shared-runtime.example/p123/api/__internal/project/config',
    'GET https://control.spala.example/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff',
    'POST https://shared-runtime.example/p123/mcp/agent-instructions',
  ]);
});

test('project preparation rejects an initial handoff that contains the fetched access credential', async () => {
  const projectToken = 'temporary-initial-handoff-secret';
  const projectUrl = 'https://project.example';
  const runtimeCalls: URL[] = [];
  const api = createSpalaApiClient(config, 'opaque-public-mcp-access', fetchStub((url) => {
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') {
      return jsonResponse({
        projectId: 'project-1',
        projectName: 'One',
        status: 'ready',
        projectUrl,
        mcpEnabled: true,
        mcpUrl: `https://shared-runtime.example/${projectToken}/mcp`,
        manifestUrl: `https://shared-runtime.example/${projectToken}/mcp/install-manifest`,
      });
    }
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url') {
      return jsonResponse(projectAccessUrl(projectUrl, projectToken));
    }
    runtimeCalls.push(url);
    return jsonResponse({ error: 'runtime must not be reached' }, 500);
  }));

  await assert.rejects(api.prepareProjectMcp('project-1', 'codex'), (error: unknown) => {
    assert.ok(error instanceof SpalaApiError);
    assert.equal(error.code, 'invalid_project_access_handoff');
    assert.doesNotMatch(error.message, new RegExp(projectToken));
    return true;
  });
  assert.equal(runtimeCalls.length, 0);
});

test('project preparation rejects a refreshed runtime that differs from the exchange runtime', async () => {
  const projectToken = 'temporary-runtime-binding-token';
  const runtimeBuilderToken = 'builder-runtime-binding-token';
  const projectUrl = 'https://project.example';
  let handoffReads = 0;
  const runtimeCalls: string[] = [];
  const api = createSpalaApiClient(config, 'opaque-public-mcp-access', fetchStub((url) => {
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') {
      handoffReads += 1;
      const runtimeSlug = handoffReads === 1 ? 'p123' : 'p456';
      return jsonResponse({
        projectId: 'project-1',
        projectName: 'One',
        status: 'ready',
        projectUrl,
        mcpEnabled: true,
        mcpUrl: `https://shared-runtime.example/${runtimeSlug}/mcp`,
        manifestUrl: `https://shared-runtime.example/${runtimeSlug}/mcp/install-manifest`,
      });
    }
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url') {
      return jsonResponse(projectAccessUrl(projectUrl, projectToken));
    }
    runtimeCalls.push(`${url.origin}${url.pathname}`);
    if (url.pathname === '/p123/api/__internal/builder-auth/external') {
      return jsonResponse({ token: runtimeBuilderToken });
    }
    if (url.pathname === '/p123/api/__internal/project/config') {
      return jsonResponse({ success: true });
    }
    return jsonResponse({ error: 'refreshed runtime must not receive the token' }, 500);
  }));

  await assert.rejects(api.prepareProjectMcp('project-1', 'codex'), (error: unknown) => {
    assert.ok(error instanceof SpalaApiError);
    assert.equal(error.code, 'invalid_project_bootstrap_material');
    assert.doesNotMatch(error.message, new RegExp(`${projectToken}|${runtimeBuilderToken}`));
    return true;
  });
  assert.deepEqual(runtimeCalls, [
    'https://shared-runtime.example/p123/api/__internal/builder-auth/external',
    'https://shared-runtime.example/p123/api/__internal/project/config',
  ]);
});

test('project preparation refreshes the authoritative handoff after enabling MCP', async () => {
  const projectToken = 'temporary-refresh-url-token';
  const builderToken = 'builder-refresh-url-token';
  const runtimeBuilderToken = 'builder-refresh-runtime-token';
  const projectUrl = 'https://project.example';
  const authoritativeMcpUrl = 'https://shared-runtime.example/p123/mcp';
  const authoritativeManifestUrl = 'https://shared-runtime.example/p123/mcp/install-manifest';
  let handoffReads = 0;
  let mcpEnabled = false;
  let handoffReadsAtInstruction: number | undefined;
  const api = createSpalaApiClient(config, 'opaque-public-mcp-access', fetchStub((url) => {
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') {
      handoffReads += 1;
      return !mcpEnabled
        ? jsonResponse({
            projectId: 'project-1',
            projectName: 'One',
            status: 'ready',
            projectUrl,
            mcpEnabled: false,
          })
        : jsonResponse({
            projectId: 'project-1',
            projectName: 'One',
            status: 'ready',
            projectUrl,
            mcpEnabled: true,
            mcpUrl: authoritativeMcpUrl,
            manifestUrl: authoritativeManifestUrl,
          });
    }
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url') {
      return jsonResponse(projectAccessUrl(projectUrl, projectToken));
    }
    if (url.origin === projectUrl && url.pathname === '/api/__internal/builder-auth/external') {
      return jsonResponse({ token: builderToken });
    }
    if (url.origin === projectUrl && url.pathname === '/api/__internal/project/config') {
      mcpEnabled = true;
      return jsonResponse({ success: true });
    }
    if (
      url.origin === 'https://shared-runtime.example'
      && url.pathname === '/p123/api/__internal/builder-auth/external'
    ) {
      return jsonResponse({ token: runtimeBuilderToken });
    }
    if (
      url.origin === 'https://shared-runtime.example'
      && url.pathname === '/p123/mcp/agent-instructions'
    ) {
      handoffReadsAtInstruction = handoffReads;
      return agentInstructionSession(
        'https://shared-runtime.example/p123/mcp/agent-instructions/mcp_agent_refresh/consume',
      );
    }
    return jsonResponse({ error: 'unexpected_request' }, 500);
  }));

  const prepared = await api.prepareProjectMcp('project-1', 'codex');

  assert.equal(handoffReads, 2);
  assert.equal(handoffReadsAtInstruction, 2, 'the authoritative handoff must be refreshed before session creation');
  assert.equal(mcpEnabled, true);
  assert.equal(prepared.mcpUrl, `${authoritativeMcpUrl}?scope=builder%2Cproject%2Cdata`);
  assert.equal(prepared.manifestUrl, `${authoritativeManifestUrl}?scope=builder%2Cproject%2Cdata`);
  assert.equal(
    prepared.bootstrapConsumeUrl,
    'https://shared-runtime.example/p123/mcp/agent-instructions/mcp_agent_refresh/consume',
  );
});

test('project preparation rejects a refreshed handoff that widens the authorized scope', async () => {
  const projectToken = 'temporary-scope-mismatch-token';
  const builderToken = 'builder-scope-mismatch-token';
  const projectUrl = 'https://project.example';
  let handoffReads = 0;
  let requestedScope: unknown;
  const api = createSpalaApiClient(config, 'opaque-public-mcp-access', fetchStub((url, init) => {
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') {
      handoffReads += 1;
      const scope = handoffReads === 1 ? 'builder%2Cproject' : 'builder%2Cproject%2Cdata';
      return jsonResponse({
        projectId: 'project-1',
        projectName: 'One',
        status: 'ready',
        projectUrl,
        mcpEnabled: true,
        mcpUrl: `${projectUrl}/mcp?scope=${scope}`,
        manifestUrl: `${projectUrl}/mcp/install-manifest?scope=${scope}`,
      });
    }
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url') {
      return jsonResponse(projectAccessUrl(projectUrl, projectToken));
    }
    if (url.origin === projectUrl && url.pathname === '/api/__internal/builder-auth/external') {
      return jsonResponse({ token: builderToken });
    }
    if (url.origin === projectUrl && url.pathname === '/api/__internal/project/config') {
      return jsonResponse({ success: true });
    }
    if (url.origin === projectUrl && url.pathname === '/mcp/agent-instructions') {
      requestedScope = (JSON.parse(String(init.body || '{}')) as Record<string, unknown>)['scope'];
      return agentInstructionSession(
        `${projectUrl}/mcp/agent-instructions/mcp_agent_scope_mismatch/consume`,
        'builder,project',
      );
    }
    return jsonResponse({ error: 'unexpected_request' }, 500);
  }));

  await assert.rejects(api.prepareProjectMcp('project-1', 'codex'), (error: unknown) => {
    assert.ok(error instanceof SpalaApiError);
    assert.equal(error.code, 'project_mcp_scope_mismatch');
    return true;
  });
  assert.equal(requestedScope, undefined, 'scope mismatch must fail before creating a bootstrap capability');
});

test('project preparation rejects bootstrap sessions that widen, narrow, or weaken the authorized binding', async () => {
  const projectToken = 'temporary-session-binding-token';
  const builderToken = 'builder-session-binding-token';
  const runtimeBuilderToken = 'builder-session-binding-runtime-token';
  const projectUrl = 'https://project.example';
  const mcpUrl = 'https://shared-runtime.example/p123/mcp/?scope=builder%2Cproject';
  const manifestUrl = 'https://shared-runtime.example/p123/mcp/install-manifest?scope=builder%2Cproject';

  for (const fixture of [
    { label: 'narrowed scope', sessionScope: 'builder', deliveryMode: 'one-time' },
    { label: 'widened scope', sessionScope: 'builder,project,data', deliveryMode: 'one-time' },
    { label: 'manual delivery', sessionScope: 'builder,project', deliveryMode: 'manual' },
  ]) {
    let instructionRequests = 0;
    const api = createSpalaApiClient(config, 'opaque-public-mcp-access', fetchStub((url) => {
      if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') {
        return jsonResponse({
          projectId: 'project-1',
          projectName: 'One',
          status: 'ready',
          projectUrl,
          mcpEnabled: true,
          mcpUrl,
          manifestUrl,
        });
      }
      if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url') {
        return jsonResponse(projectAccessUrl(projectUrl, projectToken));
      }
      if (url.origin === projectUrl && url.pathname === '/api/__internal/builder-auth/external') {
        return jsonResponse({ token: builderToken });
      }
      if (url.origin === projectUrl && url.pathname === '/api/__internal/project/config') {
        return jsonResponse({ success: true });
      }
      if (
        url.origin === 'https://shared-runtime.example'
        && url.pathname === '/p123/api/__internal/builder-auth/external'
      ) {
        return jsonResponse({ token: runtimeBuilderToken });
      }
      if (
        url.origin === 'https://shared-runtime.example'
        && url.pathname === '/p123/api/__internal/project/config'
      ) {
        return jsonResponse({ success: true });
      }
      if (
        url.origin === 'https://shared-runtime.example'
        && url.pathname === '/p123/mcp/agent-instructions'
      ) {
        instructionRequests += 1;
        return agentInstructionSession(
          'https://shared-runtime.example/p123/mcp/agent-instructions/mcp_agent_binding/consume',
          fixture.sessionScope,
          fixture.deliveryMode,
        );
      }
      return jsonResponse({ error: 'unexpected_request' }, 500);
    }));

    await assert.rejects(api.prepareProjectMcp('project-1', 'codex'), (error: unknown) => {
      assert.ok(error instanceof SpalaApiError);
      assert.equal(error.code, 'invalid_project_bootstrap_material', fixture.label);
      return true;
    });
    assert.equal(instructionRequests, 1, fixture.label);
  }
});

test('shared runtime exchange failures stay internal and never create a bootstrap capability', async () => {
  const controlToken = 'control-runtime-exchange-secret';
  const projectToken = 'temporary-runtime-exchange-secret';
  const builderToken = 'builder-entry-runtime-exchange-secret';
  const projectUrl = 'https://project.example';
  const mcpUrl = 'https://shared-runtime.example/p123/mcp?scope=builder%2Cproject';
  const manifestUrl = 'https://shared-runtime.example/p123/mcp/install-manifest?scope=builder%2Cproject';

  const calls: string[] = [];
  const api = createSpalaApiClient(config, controlToken, fetchStub((url) => {
      calls.push(`${url.origin}${url.pathname}`);
      if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') {
        return jsonResponse({
          projectId: 'project-1',
          projectName: 'One',
          status: 'ready',
          projectUrl,
          mcpEnabled: true,
          mcpUrl,
          manifestUrl,
        });
      }
      if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url') {
        return jsonResponse(projectAccessUrl(projectUrl, projectToken));
      }
      if (
        url.origin === 'https://shared-runtime.example'
        && url.pathname === '/p123/api/__internal/builder-auth/external'
      ) {
        return jsonResponse({
          error: {
            code: 'invalid_token',
            message: `${controlToken} ${projectToken} ${builderToken}`,
          },
        }, 401);
      }
      return jsonResponse({ error: 'bootstrap capability must not be created' }, 500);
  }));

  await assert.rejects(api.prepareProjectMcp('project-1', 'codex'), (error: unknown) => {
    assert.ok(error instanceof SpalaApiError);
    assert.equal(error.category, 'authentication');
    assert.equal(error.status, 401);
    assert.equal(error.code, 'project_token_exchange_failed');
    assert.doesNotMatch(error.message, new RegExp(`${controlToken}|${projectToken}`));
    return true;
  });
  assert.equal(calls.filter(call => call.endsWith('/p123/api/__internal/builder-auth/external')).length, 1);
  assert.equal(calls.some(call => call.endsWith('/p123/mcp/agent-instructions')), false);
  assert.equal(calls.at(-1), 'https://shared-runtime.example/p123/api/__internal/builder-auth/external');
});

test('project preparation rejects authoritative handoff URLs containing credentials', async () => {
  const controlToken = 'control=authoritative-url-secret';
  const projectToken = 'temporary?authoritative-url-secret';
  const builderToken = 'builder=authoritative-url-secret';
  const projectUrl = 'https://project.example';

  for (const leakedToken of [controlToken, projectToken, builderToken]) {
    for (const leakedField of ['mcpUrl', 'manifestUrl', 'projectName', 'status'] as const) {
      let handoffReads = 0;
      const warnings: unknown[][] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args);
      try {
        const api = createSpalaApiClient(config, controlToken, fetchStub((url) => {
          if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') {
            handoffReads += 1;
            const handoff = projectMcpHandoff(projectUrl);
            if (handoffReads > 1) {
              if (leakedField === 'mcpUrl') {
                handoff[leakedField] = `https://shared-runtime.example/${encodeURIComponent(leakedToken)}/mcp`;
              } else if (leakedField === 'manifestUrl') {
                handoff[leakedField] = `https://shared-runtime.example/${encodeURIComponent(leakedToken)}/mcp/install-manifest`;
              } else {
                handoff[leakedField] = `prefix%zz${encodeURIComponent(leakedToken)}`;
              }
            }
            return jsonResponse(handoff);
          }
          if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url') {
            return jsonResponse(projectAccessUrl(projectUrl, projectToken));
          }
          if (url.origin === projectUrl && url.pathname === '/api/__internal/builder-auth/external') {
            return jsonResponse({ token: builderToken });
          }
          if (url.origin === projectUrl && url.pathname === '/api/__internal/project/config') {
            return jsonResponse({ success: true });
          }
          if (url.origin === projectUrl && url.pathname === '/mcp/agent-instructions') {
            return agentInstructionSession(
              `${projectUrl}/mcp/agent-instructions/mcp_agent_sensitive/consume`,
            );
          }
          return jsonResponse({ error: 'unexpected_request' }, 500);
        }));

        await assert.rejects(api.prepareProjectMcp('project-1', 'codex'), (error: unknown) => {
          assert.ok(error instanceof SpalaApiError);
          assert.equal(error.code, 'invalid_project_bootstrap_material', `${leakedField}:${leakedToken}`);
          for (const token of [controlToken, projectToken, builderToken]) {
            assert.equal(error.message.includes(token), false);
            assert.equal(error.message.includes(encodeURIComponent(token)), false);
          }
          return true;
        });
        const warningText = JSON.stringify(warnings);
        for (const token of [controlToken, projectToken, builderToken]) {
          assert.equal(warningText.includes(token), false);
          assert.equal(warningText.includes(encodeURIComponent(token)), false);
        }
      } finally {
        console.warn = originalWarn;
      }
    }
  }
});

test('project access handoff must resolve to the exact project backend before using its token', async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const api = createSpalaApiClient(config, 'opaque-public-mcp-access', fetchStub((url, init) => {
    calls.push({ url, init });
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') {
      return jsonResponse(projectMcpHandoff());
    }
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url') {
      return jsonResponse(projectAccessUrl('https://other-project.example', 'temporary-project-secret'));
    }
    return jsonResponse({ error: 'unexpected_request' }, 500);
  }));

  await assert.rejects(api.prepareProjectMcp('project-1', 'codex'), (error: unknown) => {
    assert.ok(error instanceof SpalaApiError);
    assert.equal(error.category, 'invalid_upstream_response');
    assert.equal(error.code, 'invalid_project_access_handoff');
    assert.doesNotMatch(error.message, /opaque-public-mcp-access|temporary-project-secret/);
    return true;
  });
  assert.deepEqual(calls.map(call => `${call.init.method} ${call.url.origin}${call.url.pathname}`), [
    'GET https://control.spala.example/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff',
    'GET https://control.spala.example/api/__internal/public-mcp/v1/projects/project-1/access-url',
  ]);
  assert.equal(calls.some(call => call.url.origin === 'https://other-project.example'), false);
});

test('project preparation rejects invalid and conflicting MCP handoffs before resolving access', async () => {
  const handoffPayloads = [
    null,
    { ...projectMcpHandoff(), projectId: 'project-2' },
  ];

  for (const handoffPayload of handoffPayloads) {
    const calls: URL[] = [];
    const api = createSpalaApiClient(config, 'control-plane-handoff-secret', fetchStub((url) => {
      calls.push(url);
      if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') return jsonResponse(handoffPayload);
      return jsonResponse({ error: 'access-url must not be requested' }, 500);
    }));

    await assert.rejects(api.prepareProjectMcp('project-1', 'codex'), (error: unknown) => {
      assert.ok(error instanceof SpalaApiError);
      assert.equal(error.category, 'invalid_upstream_response');
      assert.equal(error.code, 'invalid_project_mcp_handoff');
      assert.doesNotMatch(error.message, /control-plane-handoff-secret/);
      return true;
    });
    assert.deepEqual(calls.map(url => url.pathname), ['/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff']);
  }
});

test('project preparation assigns a stable code to invalid access handoffs without exposing credentials', async () => {
  const controlToken = 'control-plane-access-handoff-secret';
  const projectToken = 'temporary-access-handoff-secret';
  const api = createSpalaApiClient(config, controlToken, fetchStub((url) => {
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') {
      return jsonResponse(projectMcpHandoff());
    }
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url') {
      return jsonResponse({
        url: `https://app.spala.ai/?url=not-base64&auth_token=${projectToken}`,
      });
    }
    return jsonResponse({ error: controlToken }, 500);
  }));

  await assert.rejects(api.prepareProjectMcp('project-1', 'codex'), (error: unknown) => {
    assert.ok(error instanceof SpalaApiError);
    assert.equal(error.category, 'invalid_upstream_response');
    assert.equal(error.code, 'invalid_project_access_handoff');
    assert.doesNotMatch(error.message, new RegExp(`${controlToken}|${projectToken}`));
    return true;
  });
});

test('project backend failures receive stage-specific fallback codes without exposing credentials', async () => {
  const controlToken = 'control-plane-stage-secret';
  const projectToken = 'temporary-stage-secret';
  const builderToken = 'builder-stage-secret';

  for (const [stage, expectedCode] of [
    ['/api/__internal/project/config', 'project_mcp_enable_failed'],
    ['/mcp/agent-instructions', 'project_agent_instruction_failed'],
  ] as const) {
    const projectCalls: string[] = [];
    const api = createSpalaApiClient(config, controlToken, fetchStub((url) => {
      if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') {
        return jsonResponse(projectMcpHandoff());
      }
      if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url') {
        return jsonResponse(projectAccessUrl('https://project.example', projectToken));
      }
      if (url.origin === 'https://project.example' && url.pathname === '/api/__internal/builder-auth/external') {
        return jsonResponse({ token: builderToken });
      }
      if (url.origin === 'https://project.example') {
        projectCalls.push(url.pathname);
        if (url.pathname === stage) throw new Error(`backend network failure ${controlToken} ${projectToken}`);
        if (url.pathname === '/api/__internal/project/config') return jsonResponse({ success: true });
        if (url.pathname === '/mcp/agent-instructions') {
          return agentInstructionSession(
            'https://project.example/mcp/agent-instructions/mcp_agent_session/consume',
          );
        }
      }
      return jsonResponse({ error: 'unexpected_request' }, 500);
    }));

    await assert.rejects(api.prepareProjectMcp('project-1', 'roo'), (error: unknown) => {
      assert.ok(error instanceof SpalaApiError);
      assert.equal(error.category, 'upstream_unavailable');
      assert.equal(error.code, expectedCode);
      assert.doesNotMatch(error.message, new RegExp(`${controlToken}|${projectToken}`));
      return true;
    });
    assert.deepEqual(projectCalls, stage === '/api/__internal/project/config'
      ? ['/api/__internal/project/config']
      : ['/api/__internal/project/config', '/mcp/agent-instructions']);
  }
});

test('project token exchange rejects missing or unchanged builder tokens with a stable stage code', async () => {
  const temporaryToken = 'temporary-exchange-secret';
  for (const exchangeResponse of [{}, { token: temporaryToken }]) {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const api = createSpalaApiClient(config, 'opaque-public-mcp-exchange', fetchStub((url, init) => {
      calls.push({ url, init });
      if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') return jsonResponse(projectMcpHandoff());
      if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url') {
        return jsonResponse(projectAccessUrl('https://project.example', temporaryToken));
      }
      if (url.origin === 'https://project.example' && url.pathname === '/api/__internal/builder-auth/external') {
        return jsonResponse(exchangeResponse);
      }
      return jsonResponse({ error: 'must not reach project setup' }, 500);
    }));

    await assert.rejects(api.prepareProjectMcp('project-1', 'codex'), (error: unknown) => {
      assert.ok(error instanceof SpalaApiError);
      assert.equal(error.category, 'invalid_upstream_response');
      assert.equal(error.code, 'project_token_exchange_failed');
      assert.doesNotMatch(error.message, /opaque-public-mcp-exchange|temporary-exchange-secret/);
      return true;
    });
    const exchangeCall = calls.at(-1)!;
    assert.equal(new Headers(exchangeCall.init.headers).get('authorization'), null);
    assert.equal(exchangeCall.init.body, JSON.stringify({ token: temporaryToken }));
    assert.equal(calls.filter(call => call.url.pathname === '/api/__internal/project/config').length, 0);
  }
});

test('agent instructions 404 preserves not-found category and status with a stable stage code', async () => {
  const projectToken = 'temporary-agent-instruction-404-secret';
  const builderToken = 'builder-agent-instruction-404-secret';
  const projectCalls: string[] = [];
  const api = createSpalaApiClient(config, 'opaque-public-mcp-access', fetchStub((url) => {
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') return jsonResponse(projectMcpHandoff());
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url') {
      return jsonResponse(projectAccessUrl('https://project.example', projectToken));
    }
    if (url.origin === 'https://project.example' && url.pathname === '/api/__internal/builder-auth/external') {
      return jsonResponse({ token: builderToken });
    }
    if (url.origin === 'https://project.example' && url.pathname === '/api/__internal/project/config') {
      projectCalls.push(url.pathname);
      return jsonResponse({ success: true });
    }
    if (url.origin === 'https://project.example' && url.pathname === '/mcp/agent-instructions') {
      projectCalls.push(url.pathname);
      return jsonResponse({ error: { code: 'not_found', message: `missing instructions ${builderToken}` } }, 404);
    }
    return jsonResponse({ error: 'unexpected_request' }, 500);
  }));

  await assert.rejects(api.prepareProjectMcp('project-1', 'codex'), (error: unknown) => {
    assert.ok(error instanceof SpalaApiError);
    assert.equal(error.category, 'not_found');
    assert.equal(error.status, 404);
    assert.equal(error.code, 'project_agent_instruction_failed');
    assert.doesNotMatch(error.message, new RegExp(`${projectToken}|${builderToken}`));
    return true;
  });
  assert.deepEqual(projectCalls, ['/api/__internal/project/config', '/mcp/agent-instructions']);
});

test('project runtime access accepts the platform access-url response field', async () => {
  const projectToken = 'temporary-alias-token';
  const builderToken = 'builder-alias-token';
  const projectCalls: URL[] = [];
  const api = createSpalaApiClient(config, 'opaque-public-mcp-access', fetchStub((url) => {
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') {
      return jsonResponse(projectMcpHandoff());
    }
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url') {
      return jsonResponse(projectAccessUrl('https://project.example', projectToken));
    }
    if (url.origin === 'https://project.example' && url.pathname === '/api/__internal/builder-auth/external') {
      return jsonResponse({ token: builderToken });
    }
    if (url.origin === 'https://project.example') {
      projectCalls.push(url);
      if (url.pathname === '/api/__internal/project/config') return jsonResponse({ success: true });
      if (url.pathname === '/mcp/agent-instructions') {
        return agentInstructionSession(
          'https://project.example/mcp/agent-instructions/mcp_agent_session/consume',
        );
      }
    }
    return jsonResponse({ error: 'unexpected_request' }, 500);
  }));

  const prepared = await api.prepareProjectMcp('project-1', 'codex');
  assert.equal(prepared.projectId, 'project-1');
  assert.deepEqual(projectCalls.map(url => url.pathname), ['/api/__internal/project/config', '/mcp/agent-instructions']);
  assert.doesNotMatch(JSON.stringify(prepared), new RegExp(projectToken));
});

test('project runtime access rejects invented typed credential fields', async () => {
  const projectToken = 'project-entry-token';
  const projectCalls: URL[] = [];
  const api = createSpalaApiClient(config, 'opaque-public-mcp-access', fetchStub((url) => {
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') {
      return jsonResponse(projectMcpHandoff());
    }
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url') {
      return jsonResponse({
        projectUrl: 'https://project.example',
        projectAccessToken: projectToken,
      });
    }
    if (url.origin === 'https://project.example') projectCalls.push(url);
    return jsonResponse({ error: 'unexpected_request' }, 500);
  }));

  await assert.rejects(api.prepareProjectMcp('project-1', 'codex'), (error: unknown) => {
    assert.ok(error instanceof SpalaApiError);
    assert.equal(error.category, 'invalid_upstream_response');
    assert.doesNotMatch(error.message, new RegExp(projectToken));
    return true;
  });
  assert.equal(projectCalls.length, 0);
});

test('project admin config failure stops before agent instructions and redacts the temporary token', async () => {
  const projectToken = 'temporary-project-error-secret';
  const builderToken = 'builder-project-error-secret';
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const api = createSpalaApiClient(config, 'opaque-public-mcp-access', fetchStub((url, init) => {
    calls.push({ url, init });
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') {
      return jsonResponse(projectMcpHandoff());
    }
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url') {
      return jsonResponse(projectAccessUrl('https://project.example', projectToken));
    }
    if (url.origin === 'https://project.example' && url.pathname === '/api/__internal/builder-auth/external') {
      return jsonResponse({ token: builderToken });
    }
    if (url.origin === 'https://project.example' && url.pathname === '/api/__internal/project/config') {
      return jsonResponse({ error: { code: 'forbidden', message: `project rejected ${builderToken}` } }, 403);
    }
    return jsonResponse({ error: 'agent instructions must not be requested' }, 500);
  }));

  await assert.rejects(api.prepareProjectMcp('project-1', 'roo'), (error: unknown) => {
    assert.ok(error instanceof SpalaApiError);
    assert.equal(error.category, 'forbidden');
    assert.equal(error.status, 403);
    assert.equal(error.code, 'project_mcp_enable_failed');
    assert.doesNotMatch(error.message, new RegExp(`${projectToken}|${builderToken}`));
    return true;
  });
  assert.deepEqual(calls.filter(call => call.url.origin === 'https://project.example')
    .map(call => `${call.init.method} ${call.url.pathname}`), [
      'POST /api/__internal/builder-auth/external',
      'POST /api/__internal/project/config',
    ]);
});

test('project preparation treats bootstrap consumption URLs as opaque and rejects missing or bearer-leaking values', async () => {
  const controlToken = 'control-plane-secret';
  const invalidUrls = [
    undefined,
    '',
    `https://project.example/mcp/bootstrap?session=${controlToken}`,
  ];

  for (const bootstrapConsumeUrl of invalidUrls) {
    const calls: URL[] = [];
    const api = createSpalaApiClient(config, controlToken, fetchStub((url, init) => {
      calls.push(url);
      if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') {
        return jsonResponse(projectMcpHandoff());
      }
      if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url') {
        return jsonResponse(projectAccessUrl('https://project.example', 'project-entry-token'));
      }
      if (url.origin === 'https://project.example' && url.pathname === '/api/__internal/builder-auth/external') {
        return jsonResponse({ token: 'builder-bootstrap-token' });
      }
      if (url.pathname === '/api/__internal/project/config' && init.method === 'POST') return jsonResponse({ success: true });
      if (url.pathname === '/mcp/agent-instructions') return agentInstructionSession(bootstrapConsumeUrl);
      return jsonResponse({ error: 'not_found' }, 404);
    }));
    await assert.rejects(api.prepareProjectMcp('project-1', 'roo'), (error: unknown) => {
      assert.ok(error instanceof SpalaApiError);
      assert.equal(error.category, 'invalid_upstream_response');
      assert.equal(error.code, 'invalid_project_bootstrap_material');
      assert.doesNotMatch(error.message, /control-plane-secret|project-entry-token/);
      return true;
    });
    assert.equal(calls.some(url => url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp/prepare'), false);
  }
});

test('project preparation rejects a bootstrap capability outside the authoritative MCP endpoint', async () => {
  const projectToken = 'temporary-legacy-bootstrap-token';
  const builderToken = 'builder-legacy-bootstrap-token';
  const projectUrl = 'https://property-listings.example.spala.ai';
  const api = createSpalaApiClient(config, 'opaque-public-mcp-access', fetchStub((url, init) => {
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') return jsonResponse(projectMcpHandoff(projectUrl));
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url') {
      return jsonResponse(projectAccessUrl(projectUrl, projectToken));
    }
    if (url.origin === projectUrl && url.pathname === '/api/__internal/builder-auth/external') {
      return jsonResponse({ token: builderToken });
    }
    if (url.origin === projectUrl && url.pathname === '/api/__internal/project/config') return jsonResponse({ success: true });
    if (url.origin === projectUrl && url.pathname === '/mcp/agent-instructions') {
      return agentInstructionSession(
        'https://example.spala.ai/property-listings/mcp/agent-instructions/mcp_agent_legacy/consume',
      );
    }
    return jsonResponse({ error: 'unexpected_request' }, 500);
  }));

  await assert.rejects(api.prepareProjectMcp('project-1', 'codex'), (error: unknown) => {
    assert.ok(error instanceof SpalaApiError);
    assert.equal(error.code, 'invalid_project_bootstrap_material');
    return true;
  });
});

test('project preparation rejects a bootstrap capability from an unrelated public host', async () => {
  const projectToken = 'temporary-unrelated-bootstrap-token';
  const builderToken = 'builder-unrelated-bootstrap-token';
  const projectUrl = 'https://property-listings.example.spala.ai';
  const api = createSpalaApiClient(config, 'opaque-public-mcp-access', fetchStub((url) => {
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/mcp-handoff') return jsonResponse(projectMcpHandoff(projectUrl));
    if (url.pathname === '/api/__internal/public-mcp/v1/projects/project-1/access-url') {
      return jsonResponse(projectAccessUrl(projectUrl, projectToken));
    }
    if (url.origin === projectUrl && url.pathname === '/api/__internal/builder-auth/external') {
      return jsonResponse({ token: builderToken });
    }
    if (url.origin === projectUrl && url.pathname === '/api/__internal/project/config') return jsonResponse({ success: true });
    if (url.origin === projectUrl && url.pathname === '/mcp/agent-instructions') {
      return agentInstructionSession(
        'https://attacker.example/mcp/agent-instructions/mcp_agent_stolen/consume',
      );
    }
    return jsonResponse({ error: 'unexpected_request' }, 500);
  }));

  await assert.rejects(api.prepareProjectMcp('project-1', 'codex'), (error: unknown) => {
    assert.ok(error instanceof SpalaApiError);
    assert.equal(error.code, 'invalid_project_bootstrap_material');
    return true;
  });
});

test('project creation auto-selects a sole organization and parses the direct POST response', async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const api = createSpalaApiClient(config, 'sole-org-token', fetchStub((url, init) => {
    calls.push({ url, init });
    if (url.pathname === '/api/__internal/public-mcp/v1/principal') {
      return jsonResponse({ user: { id: 'user-1' }, organizations: [{ id: 'org-only', name: 'Only organization' }] });
    }
    return jsonResponse({
      id: 'project-created',
      project_name: 'Sole Organization Project',
      status: 'creating',
      subdomain: 'sole-organization-project',
    }, 201);
  }));

  const created = await api.createProject({ name: 'Sole Organization Project' });
  assert.equal(created.organization.id, 'org-only');
  assert.deepEqual(created.project, {
    id: 'project-created',
    name: 'Sole Organization Project',
    status: 'creating',
    subdomain: 'sole-organization-project',
    organizationId: 'org-only',
  });
  assert.equal(calls[1]?.init.body, JSON.stringify({
    project_name: 'Sole Organization Project',
    organization_id: 'org-only',
  }));
});

test('organization creation writes only the requested name and parses the new organization safely', async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const api = createSpalaApiClient(config, 'organization-token', fetchStub((url, init) => {
    calls.push({ url, init });
    if (url.pathname === '/api/__internal/public-mcp/v1/organizations' && init.method === 'POST') {
      return jsonResponse({ organization: { organization_id: 'org-2', name: 'Second Workspace' } }, 201);
    }
    return jsonResponse({ error: 'not_found' }, 404);
  }));

  assert.deepEqual(await api.createOrganization({ name: '  Second Workspace  ' }), {
    id: 'org-2',
    name: 'Second Workspace',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url.pathname, '/api/__internal/public-mcp/v1/organizations');
  assert.equal(calls[0]!.init.body, JSON.stringify({ name: 'Second Workspace' }));
  assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), 'Bearer organization-token');
});

test('caller selectors cannot change the configured upstream origin', async () => {
  const hostile = 'https://attacker.example/collect?token=x';
  const urls: URL[] = [];
  const api = createSpalaApiClient(config, 'fixed-origin-token', fetchStub((url) => {
    urls.push(url);
    if (url.pathname === '/api/__internal/public-mcp/v1/principal') {
      return jsonResponse({ user: { id: 'user-1' }, organizations: [{ id: hostile }] });
    }
    if (url.pathname === '/api/__internal/public-mcp/v1/projects') return jsonResponse([]);
    return jsonResponse({
      projectId: hostile,
      projectName: 'Hostile-looking ID',
      status: 'ready',
      projectUrl: 'https://project.example',
      mcpEnabled: false,
    });
  }));

  await api.listProjects({ organizationId: hostile });
  await api.getProjectHandoff(hostile);
  assert.equal(urls[1]?.origin, 'https://control.spala.example');
  assert.equal(urls[1]?.searchParams.get('organizationId'), hostile);
  assert.equal(urls[2]?.origin, 'https://control.spala.example');
  assert.match(urls[2]?.pathname || '', /^\/api\/__internal\/public-mcp\/v1\/projects\/https%3A%2F%2Fattacker\.example%2Fcollect%3Ftoken%3Dx\/mcp-handoff$/);
});

test('invalid, unavailable, and plan-restricted upstream responses are typed without token leakage', async () => {
  const secret = 'opaque-secret-token';
  const invalid = createSpalaApiClient(config, secret, fetchStub(() => jsonResponse({
    error: {
      code: secret,
      message: `expired ${secret}`,
      checkoutUrl: `https://billing.spala.ai/checkout/${secret}`,
    },
  }, 401)));
  await assert.rejects(invalid.getPrincipal(), (error: unknown) => {
    assert.ok(error instanceof SpalaApiError);
    assert.equal(error.category, 'authentication');
    assert.equal(error.status, 401);
    assert.equal(error.code, undefined);
    assert.equal(error.checkoutUrl, undefined);
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.match(error.message, /\[redacted\]/);
    return true;
  });

  for (const code of ['invalid_token', 'access_denied']) {
    const disabled = createSpalaApiClient(config, secret, fetchStub(() => jsonResponse({
      error: code,
      message: 'Account access is no longer available.',
    }, 403)));
    await assert.rejects(disabled.getPrincipal(), (error: unknown) => {
      assert.ok(error instanceof SpalaApiError);
      assert.equal(error.category, 'authentication', code);
      assert.equal(error.status, 403);
      assert.equal(error.code, code);
      return true;
    });
  }

  const unavailable = createSpalaApiClient(config, secret, fetchStub(() => Promise.reject(new Error(`network ${secret}`))));
  await assert.rejects(unavailable.getPrincipal(), (error: unknown) => {
    assert.ok(error instanceof SpalaApiError);
    assert.equal(error.category, 'upstream_unavailable');
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });

  const leakedHandoff = createSpalaApiClient(config, secret, fetchStub(() => jsonResponse({
    projectId: 'project-1',
    projectName: 'Project One',
    status: 'ready',
    projectUrl: 'https://project-one.example',
    mcpEnabled: true,
    mcpUrl: `https://runtime.example/${secret}/mcp`,
    manifestUrl: 'https://runtime.example/project-1/manifest.json',
  })));
  await assert.rejects(leakedHandoff.getProjectHandoff('project-1'), (error: unknown) => {
    assert.ok(error instanceof SpalaApiError);
    assert.equal(error.category, 'invalid_upstream_response');
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });

  const restricted = createSpalaApiClient(config, secret, fetchStub((url) => {
    if (url.pathname === '/api/__internal/public-mcp/v1/principal') {
      return jsonResponse({ user: { id: 'user-1' }, organizations: [{ id: 'org-1' }] });
    }
    return jsonResponse({
      error: { message: 'This project is unavailable on the free plan.', checkoutUrl: 'https://billing.spala.ai/checkout/session' },
    }, 403);
  }));
  await assert.rejects(restricted.createProject({ name: 'Paid project' }), (error: unknown) => {
    assert.ok(error instanceof SpalaApiError);
    assert.equal(error.category, 'plan_restricted');
    assert.equal(error.checkoutUrl, 'https://billing.spala.ai/checkout/session');
    return true;
  });
});

test('upstream response bodies are capped while streaming without Content-Length', async () => {
  const boundedConfig = loadConfig({
    PUBLIC_BASE_URL: 'https://mcp.spala.ai',
    SPALA_API_BASE_URL: 'https://control.spala.example',
    PUBLIC_OAUTH_ENCRYPTION_SECRET: 'test-public-oauth-encryption-secret-32-bytes',
    PUBLIC_MCP_PLATFORM_SERVICE_SECRET: 'test-public-mcp-platform-service-secret-32-bytes',
    PUBLIC_OAUTH_REPLAY_STATE_PATH: '/tmp/mcp-spala-ai-api-bounded-test-replay',
    PUBLIC_MCP_PLATFORM_RESPONSE_LIMIT_BYTES: '1024',
  });
  const encoder = new TextEncoder();
  const oversizedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('x'.repeat(700)));
      controller.enqueue(encoder.encode('y'.repeat(700)));
      controller.close();
    },
  });
  const api = createSpalaApiClient(boundedConfig, 'bounded-token', fetchStub(() => new Response(oversizedBody, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })));

  await assert.rejects(api.getPrincipal(), (error: unknown) => {
    assert.ok(error instanceof SpalaApiError);
    assert.equal(error.category, 'invalid_upstream_response');
    assert.equal(error.code, 'upstream_response_too_large');
    assert.doesNotMatch(error.message, /bounded-token/);
    return true;
  });
});
