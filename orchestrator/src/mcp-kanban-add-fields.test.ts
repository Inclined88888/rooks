/**
 * `kanban_add` (shim MCP) must forward every field its inputSchema declares.
 * The case copies fields one by one, so a field added to the schema but not to
 * the case was silently dropped (`project`: the task was created with no
 * project and no review/merge role ever resolved).
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

type Reply = { result?: { isError?: boolean; tools?: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> } };

function rpc(base: string, request: Record<string, unknown>): Promise<Reply> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TIMON_HOME: mkdtempSync(join(tmpdir(), 'timon-mcp-kanban-add-')),
    TIMON_API_TOKEN: 'test-token',
    TIMON_ORCH_URL: base,
  };
  delete env.TIMON_TRACE_ID;
  delete env.TIMON_MISSION_ID;
  const child = spawn(process.execPath, [MCP], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP timeout')); }, 5000);
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => { clearTimeout(timer); child.kill(); lines.close(); resolve(JSON.parse(line)); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, ...request }) + '\n');
  });
}

test('kanban_add forwards every key of its inputSchema to POST /api/tasks', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer | string) => { raw += String(c); });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/tasks') bodies.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ task: { id: 't1' } }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const listing = await rpc(base, { method: 'tools/list' });
    const schema = listing.result!.tools!.find((t) => t.name === 'kanban_add')!.inputSchema.properties;
    const keys = Object.keys(schema);
    const args = Object.fromEntries(keys.map((k) => [k, k]));
    // `deps` / `priority` / `scheduled_at` / `todo_id` are not strings in the schema.
    Object.assign(args, { deps: ['d1'], priority: 3, scheduled_at: 1, todo_id: 1 });
    const reply = await rpc(base, { method: 'tools/call', params: { name: 'kanban_add', arguments: args } });
    assert.notEqual(reply.result?.isError, true);
    assert.equal(bodies.length, 1);
    const missing = keys.filter((k) => !(k in bodies[0]!));
    assert.deepEqual(missing, [], `kanban_add drops declared fields: ${missing.join(', ')}`);
    assert.equal(bodies[0]!.project, 'project');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
