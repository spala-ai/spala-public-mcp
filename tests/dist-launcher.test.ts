import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

async function availablePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Port probe did not bind');
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return address.port;
}

test('production app.js launcher serves rebuilt dist and enforces MCP and shared OAuth rate limits', async () => {
  const port = await availablePort();
  const replayStatePath = mkdtempSync(join(tmpdir(), 'mcp-spala-ai-dist-replay-'));
  const child = spawn(process.execPath, ['app.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      PUBLIC_OAUTH_REPLAY_STATE_PATH: replayStatePath,
      SPALA_API_BASE_URL: 'https://api.spala.ai',
      SPALA_DASHBOARD_URL: 'https://dashboard.spala.ai',
      SPALA_PRICING_URL: 'https://spala.ai/pricing/',
      MCP_RATE_LIMIT_MAX: '2',
      PUBLIC_OAUTH_RATE_LIMIT_MAX: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        const poll = setInterval(() => {
          if (output.includes('mcp-spala-ai listening')) {
            clearInterval(poll);
            resolve();
          }
        }, 20);
        child.once('exit', code => {
          clearInterval(poll);
          reject(new Error(`dist launcher exited with ${code}: ${output}`));
        });
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`dist launcher timed out: ${output}`)), 5_000)),
    ]);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: 'mcp-spala-ai' });

    const request = () => fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    assert.equal((await request()).status, 200);
    assert.equal((await request()).status, 200);
    const limited = await request();
    assert.equal(limited.status, 429);
    const body = await limited.json() as { jsonrpc: string; error: { data: { error: string } } };
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.error.data.error, 'rate_limit_exceeded');
    assert.ok(limited.headers.get('retry-after'));

    const registration = () => fetch(`http://127.0.0.1:${port}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:3939/callback'] }),
    });
    assert.equal((await registration()).status, 201);
    const authorization = await fetch(`http://127.0.0.1:${port}/oauth/authorize`, { redirect: 'manual' });
    assert.equal(authorization.status, 400);
    const oauthLimited = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=authorization_code',
    });
    assert.equal(oauthLimited.status, 429);
    const oauthBody = await oauthLimited.json() as { error: string };
    assert.equal(oauthBody.error, 'temporarily_unavailable');
    assert.equal(oauthLimited.headers.get('cache-control'), 'no-store');
    assert.ok(oauthLimited.headers.get('retry-after'));
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2_000))]);
    }
    rmSync(replayStatePath, { recursive: true, force: true });
  }
});
