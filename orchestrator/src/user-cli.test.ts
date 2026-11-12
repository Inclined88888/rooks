/**
 * `rooks user reset-password` — prints a one-shot password, never as an
 * argument. Witness HTTP on 127.0.0.1:0.
 */
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-user-cli-'));

const ROOKS = fileURLToPath(new URL('../bin/rooks', import.meta.url));

function runNova(args: string[], env: NodeJS.ProcessEnv): Promise<{
  code: number | null; stdout: string; stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ROOKS, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += String(c); });
    child.stderr.on('data', (c: Buffer) => { stderr += String(c); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function startMock(): Promise<{ url: string; seen: { method: string; url: string }[]; close: () => Promise<void> }> {
  const seen: { method: string; url: string }[] = [];
  const users = [
    { id: 'u-ada', email: 'ada@example.com', name: 'Ada', status: 'active', is_superadmin: false },
  ];
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '';
      seen.push({ method: req.method ?? '', url });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (url === '/api/users' && req.method === 'GET') {
        return void res.end(JSON.stringify({ users }));
      }
      if (url === '/api/users/u-ada/reset-password' && req.method === 'POST') {
        return void res.end(JSON.stringify({ user: users[0], password: 'temp-password-once' }));
      }
      res.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return void reject(new Error('unexpected listen address'));
      assert.notEqual(addr.port, 3000, 'the witness must not take the production port');
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        seen,
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

test('rooks user reset-password looks up by email and prints the password once', async () => {
  const mock = await startMock();
  try {
    const env = {
      ...process.env,
      ROOKS_API: mock.url,
      ROOKS_API_TOKEN: 'cli-token',
      ROOKS_HOME: process.env.ROOKS_HOME,
    };
    const result = await runNova(['user', 'reset-password', 'ada@example.com'], env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /temp-password-once/);
    assert.match(result.stdout, /out of band/);
    assert.ok(mock.seen.some((s) => s.method === 'GET' && s.url === '/api/users'));
    assert.ok(mock.seen.some((s) => s.method === 'POST' && s.url === '/api/users/u-ada/reset-password'));
  } finally {
    await mock.close();
  }
});

test('the account administration commands left with the routes', async () => {
  const mock = await startMock();
  try {
    const env = {
      ...process.env,
      ROOKS_API: mock.url,
      ROOKS_API_TOKEN: 'cli-token',
      ROOKS_HOME: process.env.ROOKS_HOME,
    };
    for (const argv of [['user', 'disable', 'ada@example.com'], ['user', 'invite', '--email', 'eve@example.com', '--name', 'Eve'], ['role', 'list'], ['group', 'list']]) {
      const result = await runNova(argv, env);
      assert.notEqual(result.code, 0, argv.join(' '));
    }
    assert.ok(!mock.seen.some((s) => s.method === 'PATCH' || s.url === '/api/invitations' || s.url === '/api/roles' || s.url === '/api/groups'));
  } finally {
    await mock.close();
  }
});
