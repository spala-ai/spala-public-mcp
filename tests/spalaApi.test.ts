import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import {
  createSpalaApiClient,
  parseProjectHandoff,
  parseProjectMcpUrl,
  parseProjectRecord,
  SpalaApiError,
} from '../src/spalaApi.js';

const config = loadConfig({
  PUBLIC_BASE_URL: 'https://mcp.spala.ai',
  SPALA_API_BASE_URL: 'https://control.spala.example',
  PUBLIC_OAUTH_ENCRYPTION_SECRET: 'test-public-oauth-encryption-secret-32-bytes',
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

test('authenticated client reuses dashboard project access and prepares MCP directly on the project backend', async () => {
  const token = 'opaque-valid-token';
  const projectToken = 'temporary-project-token';
  const builderToken = 'builder-project-token';
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const api = createSpalaApiClient(config, token, fetchStub((url, init) => {
    calls.push({ url, init });
    if (url.pathname === '/api/me') {
      return jsonResponse({
        user: { id: 'user-1', email: 'user@example.test' },
        organizations: [{ id: 'org-1', name: 'First' }, { id: 'org-2', name: 'Second' }],
      });
    }
    if (url.pathname === '/api/projects' && init.method === 'GET') {
      return jsonResponse({ projects: [{ id: 'project-1', project_name: 'One', status: 'ready', subdomain: 'one' }] });
    }
    if (url.pathname === '/api/projects' && init.method === 'POST') {
      return jsonResponse({ project: { id: 'project-2', project_name: 'Created', status: 'creating', subdomain: 'created' } }, 201);
    }
    if (url.pathname === '/api/projects/project-1/mcp-handoff') {
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
    if (url.pathname === '/api/projects/project-1/access-url' && init.method === 'GET') {
      const encodedUrl = Buffer.from('https://one.example').toString('base64');
      return jsonResponse({ url: `https://app.spala.ai/?url=${encodeURIComponent(encodedUrl)}&auth_token=${projectToken}` });
    }
    if (url.origin === 'https://one.example' && url.pathname === '/api/__internal/builder-auth/external' && init.method === 'POST') {
      return jsonResponse({ token: builderToken });
    }
    if (url.origin === 'https://one.example' && url.pathname === '/api/__internal/project/config' && init.method === 'POST') {
      return jsonResponse({ success: true });
    }
    if (url.origin === 'https://one.example' && url.pathname === '/mcp/agent-instructions' && init.method === 'POST') {
      return jsonResponse({
        consumeUrl: 'https://one.example/mcp/agent-instructions/mcp_agent_test/consume',
      }, 201);
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
  assert.equal(prepared.bootstrapConsumeUrl, 'https://one.example/mcp/agent-instructions/mcp_agent_test/consume');

  assert.equal(calls.filter(call => call.url.pathname === '/api/me').length, 1);
  assert.equal(calls.find(call => call.init.method === 'GET' && call.url.pathname === '/api/projects')?.url.search, '?organizationId=org-1');
  const createCall = calls.find(call => call.init.method === 'POST' && call.url.pathname === '/api/projects');
  assert.equal(createCall?.init.body, JSON.stringify({ project_name: 'Created', organization_id: 'org-2' }));
  assert.equal(calls.some(call => call.url.pathname === '/api/projects/project-1/mcp/prepare'), false);
  const controlCalls = calls.filter(call => call.url.origin === 'https://control.spala.example');
  const projectCalls = calls.filter(call => call.url.origin === 'https://one.example');
  for (const call of controlCalls) {
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.cache, 'no-store');
    assert.doesNotMatch(call.url.toString(), /opaque-valid-token/);
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get('authorization'), `Bearer ${token}`);
    assert.equal(headers.get('content-type'), call.init.method === 'POST' ? 'application/json' : null);
    assert.equal([...headers.keys()].length, call.init.method === 'POST' ? 2 : 1);
    assert.doesNotMatch(String(call.init.body || ''), /opaque-valid-token/);
  }
  assert.deepEqual(projectCalls.map(call => `${call.init.method} ${call.url.pathname}`), [
    'POST /api/__internal/builder-auth/external',
    'POST /api/__internal/project/config',
    'POST /mcp/agent-instructions',
  ]);
  const exchangeCall = projectCalls[0]!;
  assert.equal(new Headers(exchangeCall.init.headers).get('authorization'), null);
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

test('project access handoff must resolve to the exact project backend before using its token', async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const api = createSpalaApiClient(config, 'dashboard-secret', fetchStub((url, init) => {
    calls.push({ url, init });
    if (url.pathname === '/api/projects/project-1/mcp-handoff') {
      return jsonResponse(projectMcpHandoff());
    }
    if (url.pathname === '/api/projects/project-1/access-url') {
      const encodedUrl = Buffer.from('https://other-project.example').toString('base64');
      return jsonResponse({ url: `https://app.spala.ai/?url=${encodeURIComponent(encodedUrl)}&auth_token=temporary-project-secret` });
    }
    return jsonResponse({ error: 'unexpected_request' }, 500);
  }));

  await assert.rejects(api.prepareProjectMcp('project-1', 'codex'), (error: unknown) => {
    assert.ok(error instanceof SpalaApiError);
    assert.equal(error.category, 'invalid_upstream_response');
    assert.equal(error.code, 'invalid_project_access_handoff');
    assert.doesNotMatch(error.message, /dashboard-secret|temporary-project-secret/);
    return true;
  });
  assert.deepEqual(calls.map(call => `${call.init.method} ${call.url.origin}${call.url.pathname}`), [
    'GET https://control.spala.example/api/projects/project-1/mcp-handoff',
    'GET https://control.spala.example/api/projects/project-1/access-url',
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
      if (url.pathname === '/api/projects/project-1/mcp-handoff') return jsonResponse(handoffPayload);
      return jsonResponse({ error: 'access-url must not be requested' }, 500);
    }));

    await assert.rejects(api.prepareProjectMcp('project-1', 'codex'), (error: unknown) => {
      assert.ok(error instanceof SpalaApiError);
      assert.equal(error.category, 'invalid_upstream_response');
      assert.equal(error.code, 'invalid_project_mcp_handoff');
      assert.doesNotMatch(error.message, /control-plane-handoff-secret/);
      return true;
    });
    assert.deepEqual(calls.map(url => url.pathname), ['/api/projects/project-1/mcp-handoff']);
  }
});

test('project preparation assigns a stable code to invalid access handoffs without exposing credentials', async () => {
  const controlToken = 'control-plane-access-handoff-secret';
  const projectToken = 'temporary-access-handoff-secret';
  const api = createSpalaApiClient(config, controlToken, fetchStub((url) => {
    if (url.pathname === '/api/projects/project-1/mcp-handoff') {
      return jsonResponse(projectMcpHandoff());
    }
    if (url.pathname === '/api/projects/project-1/access-url') {
      return jsonResponse({ url: `https://app.spala.ai/?url=not-base64&auth_token=${projectToken}` });
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
      if (url.pathname === '/api/projects/project-1/mcp-handoff') {
        return jsonResponse(projectMcpHandoff());
      }
      if (url.pathname === '/api/projects/project-1/access-url') {
        const encodedUrl = Buffer.from('https://project.example').toString('base64');
        return jsonResponse({ url: `https://app.spala.ai/?url=${encodeURIComponent(encodedUrl)}&auth_token=${projectToken}` });
      }
      if (url.origin === 'https://project.example' && url.pathname === '/api/__internal/builder-auth/external') {
        return jsonResponse({ token: builderToken });
      }
      if (url.origin === 'https://project.example') {
        projectCalls.push(url.pathname);
        if (url.pathname === stage) throw new Error(`backend network failure ${controlToken} ${projectToken}`);
        if (url.pathname === '/api/__internal/project/config') return jsonResponse({ success: true });
        if (url.pathname === '/mcp/agent-instructions') {
          return jsonResponse({ consumeUrl: 'https://project.example/mcp/agent-instructions/session/consume' }, 201);
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
    const api = createSpalaApiClient(config, 'dashboard-exchange-secret', fetchStub((url, init) => {
      calls.push({ url, init });
      if (url.pathname === '/api/projects/project-1/mcp-handoff') return jsonResponse(projectMcpHandoff());
      if (url.pathname === '/api/projects/project-1/access-url') {
        const encodedUrl = Buffer.from('https://project.example').toString('base64');
        return jsonResponse({ url: `https://app.spala.ai/?url=${encodeURIComponent(encodedUrl)}&auth_token=${temporaryToken}` });
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
      assert.doesNotMatch(error.message, /dashboard-exchange-secret|temporary-exchange-secret/);
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
  const api = createSpalaApiClient(config, 'dashboard-secret', fetchStub((url) => {
    if (url.pathname === '/api/projects/project-1/mcp-handoff') return jsonResponse(projectMcpHandoff());
    if (url.pathname === '/api/projects/project-1/access-url') {
      const encodedUrl = Buffer.from('https://project.example').toString('base64');
      return jsonResponse({ url: `https://app.spala.ai/?url=${encodeURIComponent(encodedUrl)}&auth_token=${projectToken}` });
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

test('project access handoff accepts top-level and nested URL aliases', async () => {
  const projectToken = 'temporary-alias-token';
  const builderToken = 'builder-alias-token';
  const encodedUrl = Buffer.from('https://project.example').toString('base64');
  const accessPayloads = [
    { url: `https://app.spala.ai/?url=${encodeURIComponent(encodedUrl)}&auth_token=${projectToken}` },
    { accessUrl: `https://app.spala.ai/?url=${encodeURIComponent(encodedUrl)}&auth_token=${projectToken}` },
    { data: { url: `https://app.spala.ai/?url=${encodeURIComponent(encodedUrl)}&auth_token=${projectToken}` } },
  ];

  for (const accessPayload of accessPayloads) {
    const projectCalls: URL[] = [];
    const api = createSpalaApiClient(config, 'dashboard-secret', fetchStub((url, init) => {
      if (url.pathname === '/api/projects/project-1/mcp-handoff') {
        return jsonResponse(projectMcpHandoff());
      }
      if (url.pathname === '/api/projects/project-1/access-url') return jsonResponse(accessPayload);
      if (url.origin === 'https://project.example' && url.pathname === '/api/__internal/builder-auth/external') return jsonResponse({ token: builderToken });
      if (url.origin === 'https://project.example') {
        projectCalls.push(url);
        if (url.pathname === '/api/__internal/project/config') return jsonResponse({ success: true });
        if (url.pathname === '/mcp/agent-instructions') {
          return jsonResponse({ consumeUrl: 'https://project.example/mcp/agent-instructions/session/consume' }, 201);
        }
      }
      return jsonResponse({ error: 'unexpected_request' }, 500);
    }));

    const prepared = await api.prepareProjectMcp('project-1', 'codex');
    assert.equal(prepared.projectId, 'project-1');
    assert.deepEqual(projectCalls.map(url => url.pathname), ['/api/__internal/project/config', '/mcp/agent-instructions']);
  }
});

test('project access handoff rejects conflicting URL aliases', async () => {
  const projectToken = 'project-entry-token';
  const projectUrl = 'https://project.example';
  const encodedProjectUrl = Buffer.from(projectUrl).toString('base64');
  const encodedOtherUrl = Buffer.from('https://other-project.example').toString('base64');
  const accessPayloads = [
    {
      url: `https://app.spala.ai/?url=${encodeURIComponent(encodedProjectUrl)}&auth_token=${projectToken}`,
      accessUrl: `https://app.spala.ai/?url=${encodeURIComponent(encodedOtherUrl)}&auth_token=${projectToken}`,
    },
    {
      url: `https://app.spala.ai/?url=${encodeURIComponent(encodedProjectUrl)}&auth_token=${projectToken}`,
      data: { url: `https://app.spala.ai/?url=${encodeURIComponent(encodedOtherUrl)}&auth_token=${projectToken}` },
    },
  ];

  for (const accessPayload of accessPayloads) {
    const projectCalls: URL[] = [];
    const api = createSpalaApiClient(config, 'dashboard-secret', fetchStub((url, init) => {
      if (url.pathname === '/api/projects/project-1/mcp-handoff') {
        return jsonResponse(projectMcpHandoff());
      }
      if (url.pathname === '/api/projects/project-1/access-url') return jsonResponse(accessPayload);
      if (url.origin === 'https://project.example') projectCalls.push(url);
      return jsonResponse({ error: 'unexpected_request' }, 500);
    }));

    await assert.rejects(api.prepareProjectMcp('project-1', 'codex'), (error: unknown) => {
      assert.ok(error instanceof SpalaApiError);
      assert.equal(error.category, 'invalid_upstream_response');
      return true;
    });
    assert.equal(projectCalls.length, 0);
  }
});

test('project admin config failure stops before agent instructions and redacts the temporary token', async () => {
  const projectToken = 'temporary-project-error-secret';
  const builderToken = 'builder-project-error-secret';
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const api = createSpalaApiClient(config, 'dashboard-secret', fetchStub((url, init) => {
    calls.push({ url, init });
    if (url.pathname === '/api/projects/project-1/mcp-handoff') {
      return jsonResponse(projectMcpHandoff());
    }
    if (url.pathname === '/api/projects/project-1/access-url') {
      const encodedUrl = Buffer.from('https://project.example').toString('base64');
      return jsonResponse({ url: `https://app.spala.ai/?url=${encodeURIComponent(encodedUrl)}&auth_token=${projectToken}` });
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
      if (url.pathname === '/api/projects/project-1/mcp-handoff') {
        return jsonResponse(projectMcpHandoff());
      }
      if (url.pathname === '/api/projects/project-1/access-url') {
        const encodedUrl = Buffer.from('https://project.example').toString('base64');
        return jsonResponse({ url: `https://app.spala.ai/?url=${encodeURIComponent(encodedUrl)}&auth_token=project-entry-token` });
      }
      if (url.origin === 'https://project.example' && url.pathname === '/api/__internal/builder-auth/external') {
        return jsonResponse({ token: 'builder-bootstrap-token' });
      }
      if (url.pathname === '/api/__internal/project/config' && init.method === 'POST') return jsonResponse({ success: true });
      if (url.pathname === '/mcp/agent-instructions') return jsonResponse({ consumeUrl: bootstrapConsumeUrl }, 201);
      return jsonResponse({ error: 'not_found' }, 404);
    }));
    await assert.rejects(api.prepareProjectMcp('project-1', 'roo'), (error: unknown) => {
      assert.ok(error instanceof SpalaApiError);
      assert.equal(error.category, 'invalid_upstream_response');
      assert.equal(error.code, 'invalid_project_bootstrap_material');
      assert.doesNotMatch(error.message, /control-plane-secret|project-entry-token/);
      return true;
    });
    assert.equal(calls.some(url => url.pathname === '/api/projects/project-1/mcp/prepare'), false);
  }
});

test('project creation auto-selects a sole organization and parses the direct POST response', async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const api = createSpalaApiClient(config, 'sole-org-token', fetchStub((url, init) => {
    calls.push({ url, init });
    if (url.pathname === '/api/me') {
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

test('caller selectors cannot change the configured upstream origin', async () => {
  const hostile = 'https://attacker.example/collect?token=x';
  const urls: URL[] = [];
  const api = createSpalaApiClient(config, 'fixed-origin-token', fetchStub((url) => {
    urls.push(url);
    if (url.pathname === '/api/me') {
      return jsonResponse({ user: { id: 'user-1' }, organizations: [{ id: hostile }] });
    }
    if (url.pathname === '/api/projects') return jsonResponse([]);
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
  assert.match(urls[2]?.pathname || '', /^\/api\/projects\/https%3A%2F%2Fattacker\.example%2Fcollect%3Ftoken%3Dx\/mcp-handoff$/);
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
    if (url.pathname === '/api/me') {
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
    PUBLIC_OAUTH_REPLAY_STATE_PATH: '/tmp/mcp-spala-ai-api-bounded-test-replay',
    SPALA_API_RESPONSE_LIMIT_BYTES: '1024',
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
