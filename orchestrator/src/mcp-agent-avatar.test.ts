/**
 * `agent_set_avatar` (shim MCP) and `timon agent set-avatar` (CLI): the image
 * is read in the caller's process, only from inside its working directory, and
 * only inline bytes reach the daemon. `agent_list` relays `icon_url`.
 * Mock daemon on 127.0.0.1:0, temporary TIMON_HOME — never the machine's.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const TIMON = fileURLToPath(new URL('../bin/timon', import.meta.url));
const MCP = fileURLToPath(new URL('../bin/timon-mcp.mjs', import.meta.url));
const { readAvatarFile, AVATAR_MAX_BYTES } = await import('../bin/avatar-file.mjs') as {
  readAvatarFile: (file: string, root?: string) => { mime: string; data: string };
  AVATAR_MAX_BYTES: number;
};

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const work = mkdtempSync(join(tmpdir(), 'timon-avatar-cwd-'));
const outside = mkdtempSync(join(tmpdir(), 'timon-avatar-outside-'));
writeFileSync(join(work, 'me.png'), PNG);
writeFileSync(join(outside, 'secret.png'), PNG);
writeFileSync(join(work, 'notes.txt'), 'hello');
writeFileSync(join(work, 'big.png'), Buffer.alloc(AVATAR_MAX_BYTES + 1));
mkdirSync(join(work, 'sub'));
symlinkSync(join(outside, 'secret.png'), join(work, 'sub', 'link.png'));

type Seen = { method: string; url: string; body: Record<string, unknown> };

async function withDaemon<T>(status: number, run: (url: string, seen: Seen[]) => Promise<T>): Promise<T> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer | string) => { raw += String(c); });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : {} });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 200
        ? { ok: true, name: 'a.b', icon_url: '/api/uploads/agents/x.png', agents: [{ name: 'a.b', role: null, reports_to: null, orchestrator: false, icon_url: '/api/uploads/agents/x.png', secret: 'no' }, { name: 'c.d' }] }
        : { error: 'forbidden' }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
  } finally {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  }
}

function env(url: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    ...process.env, TIMON_HOME: mkdtempSync(join(tmpdir(), 'timon-avatar-home-')),
    TIMON_API: url, TIMON_ORCH_URL: url, TIMON_API_TOKEN: 'test-token', TIMON_RESOURCE_GUARD_ENABLED: '0',
  };
  delete e.TIMON_MISSION_ID;
  return e;
}

function mcpCall(url: string, name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP], { env: env(url), cwd: work, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP timeout')); }, 5000);
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const line = buf.split('\n')[0];
      if (!buf.includes('\n') || !line) return;
      clearTimeout(timer);
      child.kill();
      const result = JSON.parse(line).result as { isError?: boolean; content: Array<{ text: string }> };
      resolve({ isError: result.isError, text: result.content[0]!.text });
    });
    child.on('error', reject);
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}

function runCli(url: string, args: string[]): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TIMON, ...args], { env: env(url), cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; let stdout = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr, stdout }));
  });
}

test('agent_list relays icon_url and nothing else beyond the documented fields', async () => {
  await withDaemon(200, async (url) => {
    const r = await mcpCall(url, 'agent_list', {});
    const agents = JSON.parse(r.text).agents as Array<Record<string, unknown>>;
    assert.equal(agents[0]!.icon_url, '/api/uploads/agents/x.png');
    assert.equal(agents[1]!.icon_url, null);
    assert.equal('secret' in agents[0]!, false);
  });
});

test('agent_set_avatar sends the file inline to the avatar route', async () => {
  await withDaemon(200, async (url, seen) => {
    const r = await mcpCall(url, 'agent_set_avatar', { agent_name: 'a.b', file: 'me.png' });
    assert.notEqual(r.isError, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.method, 'PUT');
    assert.equal(seen[0]!.url, '/api/agents/a.b/avatar');
    assert.deepEqual(seen[0]!.body, { mime: 'image/png', data: PNG.toString('base64') });
    assert.equal(JSON.parse(r.text).icon_url, '/api/uploads/agents/x.png');
  });
});

test('agent_set_avatar relays data_url and clear', async () => {
  await withDaemon(200, async (url, seen) => {
    await mcpCall(url, 'agent_set_avatar', { agent_name: 'a.b', data_url: 'data:image/png;base64,AAAA' });
    await mcpCall(url, 'agent_set_avatar', { agent_name: 'a.b', clear: true });
    assert.deepEqual(seen.map((s) => s.body), [{ dataUrl: 'data:image/png;base64,AAAA' }, { clear: true }]);
  });
});

test('agent_set_avatar refuses a bad file, an escape and ambiguous input without calling the daemon', async () => {
  await withDaemon(200, async (url, seen) => {
    const cases: Array<Record<string, unknown>> = [
      { agent_name: 'a.b', file: '../' + outside.split('/').pop() + '/secret.png' },
      { agent_name: 'a.b', file: join(outside, 'secret.png') },
      { agent_name: 'a.b', file: 'sub/link.png' },
      { agent_name: 'a.b', file: 'notes.txt' },
      { agent_name: 'a.b', file: 'big.png' },
      { agent_name: 'a.b', file: 'missing.png' },
      { agent_name: 'a.b' },
      { agent_name: 'a.b', file: 'me.png', clear: true },
    ];
    for (const args of cases) {
      const r = await mcpCall(url, 'agent_set_avatar', args);
      assert.equal(r.isError, true, JSON.stringify(args));
    }
    assert.equal(seen.length, 0);
  });
});

test('agent_set_avatar surfaces the daemon refusal (403)', async () => {
  await withDaemon(403, async (url) => {
    const r = await mcpCall(url, 'agent_set_avatar', { agent_name: 'a.b', file: 'me.png' });
    assert.equal(r.isError, true);
    assert.match(r.text, /403/);
  });
});

test('readAvatarFile accepts a file inside the root and refuses the rest', () => {
  assert.equal(readAvatarFile('me.png', work).mime, 'image/png');
  assert.throws(() => readAvatarFile('sub/link.png', work), /inside the working directory/);
  assert.throws(() => readAvatarFile('.', work));
});

test('timon agent set-avatar: sends the file, clears, and refuses an escape locally', async () => {
  await withDaemon(200, async (url, seen) => {
    const ok = await runCli(url, ['agent', 'set-avatar', 'a.b', 'me.png']);
    assert.equal(ok.code, 0, ok.stderr);
    const cleared = await runCli(url, ['agent', 'set-avatar', 'a.b', '--clear']);
    assert.equal(cleared.code, 0, cleared.stderr);
    assert.deepEqual(seen.map((s) => [s.method, s.url]), [['PUT', '/api/agents/a.b/avatar'], ['PUT', '/api/agents/a.b/avatar']]);
    assert.deepEqual(seen[1]!.body, { clear: true });

    const escape = await runCli(url, ['agent', 'set-avatar', 'a.b', join(outside, 'secret.png')]);
    assert.equal(escape.code, 1);
    const usage = await runCli(url, ['agent', 'set-avatar', 'a.b']);
    assert.equal(usage.code, 64);
    assert.equal(seen.length, 2);
  });
});
