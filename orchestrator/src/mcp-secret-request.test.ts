/**
 * `secret_request` (shim MCP) relays to `POST /api/secrets/requests` and copies
 * every field its inputSchema declares (a key added to the schema and not to the
 * `case` is silently dropped, cf. `mcp-secret-create.test.ts`). Outside a
 * mission it refuses before calling anything: a request is a card in ONE
 * conversation.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const MCP = fileURLToPath(new URL('../bin/timon-mcp.mjs', import.meta.url));

type Reply = { result?: { isError?: boolean; content?: Array<{ text: string }>; tools?: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> } };

function rpc(base: string, request: Record<string, unknown>, missionId?: string): Promise<Reply> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TIMON_HOME: mkdtempSync(join(tmpdir(), 'timon-mcp-secret-request-')),
    TIMON_API_TOKEN: 'test-token',
    TIMON_ORCH_URL: base,
  };
  delete env.TIMON_TRACE_ID;
  delete env.TIMON_MISSION_ID;
  if (missionId) env.TIMON_MISSION_ID = missionId;
  const child = spawn(process.execPath, [MCP], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP timeout')); }, 5000);
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => { clearTimeout(timer); child.kill(); lines.close(); resolve(JSON.parse(line)); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, ...request }) + '\n');
  });
}

type Seen = { method: string; url: string; body: Record<string, unknown> };

async function withDaemon(fn: (base: string, seen: Seen[]) => Promise<void>) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer | string) => { raw += String(c); });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : {} });
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'r1', status: 'pending', name: 'SHOP_API_KEY', message: 'card shown' }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen); } finally { server.close(); }
}

test('secret_request is listed and every schema field reaches the daemon', async () => {
  await withDaemon(async (base, seen) => {
    const list = await rpc(base, { method: 'tools/list' });
    const tool = list.result!.tools!.find((t) => t.name === 'secret_request');
    assert.ok(tool, 'secret_request must be advertised');
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['header', 'hosts', 'lifetime', 'name', 'origin', 'reason', 'template']);

    const args = { name: 'SHOP_API_KEY', reason: 'read orders', lifetime: 'once', hosts: ['api.shop.example'], header: 'X-Api-Key', template: '{{value}}' };
    const reply = await rpc(base, { method: 'tools/call', params: { name: 'secret_request', arguments: args } }, 'm-1');
    assert.equal(seen[0]!.method, 'POST');
    assert.equal(seen[0]!.url, '/api/secrets/requests');
    assert.deepEqual(seen[0]!.body, args);
    assert.equal((JSON.parse(reply.result!.content![0]!.text) as { status: string }).status, 'pending');

    const page = { name: 'SHOP_PASSWORD', reason: 'sign in', lifetime: 'once', origin: 'https://shop.example' };
    await rpc(base, { method: 'tools/call', params: { name: 'secret_request', arguments: page } }, 'm-1');
    assert.deepEqual(seen[1]!.body, page);
  });
});

test('outside a mission nothing is asked', async () => {
  await withDaemon(async (base, seen) => {
    const reply = await rpc(base, { method: 'tools/call', params: { name: 'secret_request', arguments: { name: 'X_KEY', reason: 'x', lifetime: 'once' } } });
    assert.equal(reply.result!.isError, true);
    assert.equal(seen.length, 0);
  });
});
