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

test('authenticated client verifies once, lists, creates, and returns exact handoff URLs', async () => {
  const token = 'opaque-valid-token';
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
    if (url.pathname === '/api/projects/project-1/mcp/prepare' && init.method === 'POST') {
      return jsonResponse({
        projectId: 'project-1',
        projectName: 'One',
        status: 'ready',
        projectUrl: 'https://one.example',
        mcpEnabled: true,
        mcpUrl: 'https://one.example/mcp',
        manifestUrl: 'https://one.example/mcp/install-manifest',
        bootstrapConsumeUrl: 'https://one.example/mcp/bootstrap?session=opaque-session-secret',
      });
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
  assert.equal(prepared.mcpUrl, handoff.mcpUrl);
  assert.equal(prepared.bootstrapConsumeUrl, 'https://one.example/mcp/bootstrap?session=opaque-session-secret');

  assert.equal(calls.filter(call => call.url.pathname === '/api/me').length, 1);
  assert.equal(calls.find(call => call.init.method === 'GET' && call.url.pathname === '/api/projects')?.url.search, '?organizationId=org-1');
  const createCall = calls.find(call => call.init.method === 'POST' && call.url.pathname === '/api/projects');
  assert.equal(createCall?.init.body, JSON.stringify({ project_name: 'Created', organization_id: 'org-2' }));
  const prepareCall = calls.find(call => call.url.pathname === '/api/projects/project-1/mcp/prepare');
  assert.equal(prepareCall?.init.method, 'POST');
  assert.equal(prepareCall?.init.body, JSON.stringify({ client: 'codex' }));
  for (const call of calls) {
    assert.equal(call.url.origin, 'https://control.spala.example');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.cache, 'no-store');
    assert.doesNotMatch(call.url.toString(), /opaque-valid-token/);
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get('authorization'), `Bearer ${token}`);
    assert.equal(headers.get('content-type'), call.init.method === 'POST' ? 'application/json' : null);
    assert.equal([...headers.keys()].length, call.init.method === 'POST' ? 2 : 1);
    assert.doesNotMatch(String(call.init.body || ''), /opaque-valid-token/);
  }
  assert.equal(calls.filter(call => call.url.origin === 'https://one.example').length, 0);
  assert.doesNotMatch(JSON.stringify(prepared), /opaque-valid-token/);
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
    const api = createSpalaApiClient(config, controlToken, fetchStub((url) => {
      calls.push(url);
      return jsonResponse({
        projectId: 'project-1',
        projectName: 'Project One',
        status: 'ready',
        projectUrl: 'https://project.example',
        mcpEnabled: true,
        mcpUrl: 'https://project.example/mcp',
        manifestUrl: 'https://project.example/mcp/install-manifest',
        bootstrapConsumeUrl,
      });
    }));
    await assert.rejects(api.prepareProjectMcp('project-1', 'roo'), (error: unknown) => {
      assert.ok(error instanceof SpalaApiError);
      assert.equal(error.category, 'invalid_upstream_response');
      assert.doesNotMatch(error.message, /control-plane-secret/);
      return true;
    });
    assert.deepEqual(calls.map(url => url.origin), ['https://control.spala.example']);
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
