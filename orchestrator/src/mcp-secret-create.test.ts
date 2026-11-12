/**
 * `secret_create` (shim MCP) relays to `POST /api/secrets/provision` and copies
 * every field its inputSchema declares (a key added to the schema and not to the
 * `case` is silently dropped, cf. `mcp-kanban-add-fields.test.ts`).
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

const MCP = fileURLToPath(new URL('../bin/rooks-mcp.mjs', import.meta.url));

type Reply = { result?: { isError?: boolean; content?: Array<{ text: string }>; tools?: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> } };

function rpc(base: string, request: Record<string, unknown>): Promise<Reply> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ROOKS_HOME: mkdtempSync(join(tmpdir(), 'rooks-mcp-secret-create-')),
    ROOKS_API_TOKEN: 'test-token',
    ROOKS_ORCH_URL: base,
  };
  delete env.ROOKS_TRACE_ID;
  delete env.ROOKS_MISSION_ID;
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
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ secret: { id: 's1', name: 'DB_PASSWORD' }, generated: true }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen); } finally { server.close(); }
}

test('secret_create is listed and every schema field reaches the daemon', async () => {
  await withDaemon(async (base, seen) => {
    const list = await rpc(base, { method: 'tools/list' });
    const tool = list.result!.tools!.find((t) => t.name === 'secret_create');
    assert.ok(tool, 'secret_create must be advertised');
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['generate', 'name', 'note', 'value']);

    const args = { name: 'DB_PASSWORD', generate: { length: 24, alphabet: 'hex' }, note: 'for pg' };
    const reply = await rpc(base, { method: 'tools/call', params: { name: 'secret_create', arguments: args } });
    assert.equal(seen[0]!.method, 'POST');
    assert.equal(seen[0]!.url, '/api/secrets/provision');
    assert.deepEqual(seen[0]!.body, args);
    assert.equal((JSON.parse(reply.result!.content![0]!.text) as { generated: boolean }).generated, true);
  });
});

test('a supplied value is relayed as is', async () => {
  await withDaemon(async (base, seen) => {
    await rpc(base, { method: 'tools/call', params: { name: 'secret_create', arguments: { name: 'API_KEY', value: 'v'.repeat(20) } } });
    assert.deepEqual(seen[0]!.body, { name: 'API_KEY', value: 'v'.repeat(20) });
  });
});
