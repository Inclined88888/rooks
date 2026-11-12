/**
 * `project_create` / `project_update` / `workspace_list` (shim MCP) must relay
 * every field their inputSchema declares, with the right verb and path, and ask
 * the daemon to validate the workspace (a typo must never mint a pole). The
 * `case` copies fields one by one: a key added to the schema and not to the
 * case is silently dropped (cf. `mcp-kanban-add-fields.test.ts`).
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
    ROOKS_HOME: mkdtempSync(join(tmpdir(), 'rooks-mcp-project-tools-')),
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
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        project: { slug: 'p' },
        meta: { name: 'P' },
        workspaces: [{ slug: 'design-studio', name: 'Design Studio', color: null, lead_agent: null, projects: ['p'] }],
      }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

async function schemaKeys(base: string, tool: string): Promise<string[]> {
  const listing = await rpc(base, { method: 'tools/list' });
  const found = listing.result!.tools!.find((t) => t.name === tool);
  assert.ok(found, `${tool} is not listed`);
  return Object.keys(found.inputSchema.properties);
}

test('project_create relays every schema key, asks for an existing workspace by default', async () => {
  await withDaemon(async (base, seen) => {
    const keys = await schemaKeys(base, 'project_create');
    assert.ok(keys.includes('workspace') && keys.includes('speech') && keys.includes('create_workspace'));
    const args = Object.fromEntries(keys.map((k) => [k, k]));
    args.create_workspace = false;
    const reply = await rpc(base, { method: 'tools/call', params: { name: 'project_create', arguments: args } });
    assert.notEqual(reply.result?.isError, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.method, 'POST');
    assert.equal(seen[0]!.url, '/api/projects');
    const missing = keys.filter((k) => k !== 'create_workspace' && !(k in seen[0]!.body));
    assert.deepEqual(missing, [], `project_create drops declared fields: ${missing.join(', ')}`);
    assert.equal(seen[0]!.body.workspace_policy, 'existing');
  });
});

test('create_workspace: true turns into the "create" policy', async () => {
  await withDaemon(async (base, seen) => {
    await rpc(base, { method: 'tools/call', params: { name: 'project_create', arguments: { slug: 'p', workspace: 'New', create_workspace: true } } });
    await rpc(base, { method: 'tools/call', params: { name: 'project_update', arguments: { slug: 'p', workspace: 'New', create_workspace: true } } });
    assert.deepEqual(seen.map((s) => s.body.workspace_policy), ['create', 'create']);
  });
});

test('project_update PUTs the meta of the slug, every key relayed', async () => {
  await withDaemon(async (base, seen) => {
    const keys = await schemaKeys(base, 'project_update');
    const args = Object.fromEntries(keys.map((k) => [k, k]));
    args.slug = 'my/proj';
    args.create_workspace = false;
    const reply = await rpc(base, { method: 'tools/call', params: { name: 'project_update', arguments: args } });
    assert.notEqual(reply.result?.isError, true);
    assert.equal(seen[0]!.method, 'PUT');
    assert.equal(seen[0]!.url, '/api/projects/my%2Fproj/meta');
    const missing = keys.filter((k) => k !== 'slug' && k !== 'create_workspace' && !(k in seen[0]!.body));
    assert.deepEqual(missing, [], `project_update drops declared fields: ${missing.join(', ')}`);
    assert.equal('slug' in seen[0]!.body, false, 'the slug travels in the path only');
    assert.equal(seen[0]!.body.workspace_policy, 'existing');
  });
});

test('project_update leaves unset fields out of the body', async () => {
  await withDaemon(async (base, seen) => {
    await rpc(base, { method: 'tools/call', params: { name: 'project_update', arguments: { slug: 'p', speech: '' } } });
    assert.deepEqual(seen[0]!.body, { workspace_policy: 'existing', speech: '' });
  });
});

test('workspace_list GETs /api/workspaces and returns the compact list', async () => {
  await withDaemon(async (base, seen) => {
    const reply = await rpc(base, { method: 'tools/call', params: { name: 'workspace_list', arguments: {} } });
    assert.equal(seen[0]!.method, 'GET');
    assert.equal(seen[0]!.url, '/api/workspaces');
    const out = JSON.parse(reply.result!.content![0]!.text) as Array<{ name: string; projects: string[] }>;
    assert.equal(out[0]!.name, 'Design Studio');
    assert.deepEqual(out[0]!.projects, ['p']);
  });
});
