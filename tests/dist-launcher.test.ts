import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
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

test('production app.js launcher serves rebuilt dist and enforces MCP rate limits', async () => {
  const port = await availablePort();
  const child = spawn(process.execPath, ['app.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      SPALA_API_BASE_URL: 'https://api.spala.ai',
      SPALA_DASHBOARD_URL: 'https://dashboard.spala.ai',
      DRY_RUN_PROJECT_CREATE: 'true',
      MCP_RATE_LIMIT_MAX: '2',
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
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2_000))]);
    }
  }
});
