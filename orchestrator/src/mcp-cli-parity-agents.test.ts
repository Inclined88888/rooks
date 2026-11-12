/**
 * MCP ↔ CLI parity, second half (agents, docs, spawn, refusals): the same
 * harness as src/mcp-cli-parity.test.ts, in its own file so neither one runs
 * past the runner's per-file limit.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { cli, session, withDaemon } from '../tests/helpers/mcp-cli-parity.js';

test('agent_update with a prompt keeps the existing config in the full upsert', async () => {
  await withDaemon(async (base, seen) => {
    await session(base, [{ method: 'tools/call', params: { name: 'agent_update', arguments: { name: 'a', system_prompt: 'new', model: 'm2' } } }]);
    const post = seen.find((s) => s.method === 'POST' && s.url === '/api/agents');
    assert.ok(post);
    assert.equal(post.body.system_prompt, 'new');
    assert.equal((post.body.config as Record<string, unknown>).model, 'm2');
  });
});

test('a prompt change round-trips role, picture, context and browser profile on both transports', async () => {
  const stored = {
    name: 'a', backend: 'claude', model: 'm1', skills: [],
    role: 'reviewer', icon_url: '/avatars/a.png', global_context: 'ctx', browser_profile_id: 'bp1',
  };
  const posts: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer | string) => { raw += String(c); });
    req.on('end', () => {
      if (req.method === 'POST') posts.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.method === 'GET' ? stored : { ok: true }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const promptFile = join(mkdtempSync(join(tmpdir(), 'rooks-cli-prompt-')), 'prompt.md');
    writeFileSync(promptFile, 'new prompt');
    const run = await cli(base, ['agent', 'update', 'a', '--prompt-file', promptFile, '--model', 'm2']);
    assert.equal(run.code, 0, run.out);
    await session(base, [{ method: 'tools/call', params: { name: 'agent_update', arguments: { name: 'a', system_prompt: 'new prompt', model: 'm2' } } }]);
    assert.equal(posts.length, 2);
    for (const post of posts) {
      assert.equal(post.system_prompt, 'new prompt');
      assert.deepEqual(post.config, {
        backend: 'claude', model: 'm2',
        role: 'reviewer', icon_url: '/avatars/a.png', global_context: 'ctx', browser_profile_id: 'bp1',
      });
    }
  } finally { server.closeAllConnections(); server.close(); }
});

test('rooks browser recording get takes the same route as browser_recording_get', async () => {
  await withDaemon(async (base, seen) => {
    const run = await cli(base, ['browser', 'recording', 'get', 'br-1']);
    assert.equal(run.code, 0, run.out);
    assert.ok(seen.some((s) => `${s.method} ${s.url}` === 'GET /api/native-browser/recordings/br-1'), seen.map((s) => `${s.method} ${s.url}`).join(', '));
    const usage = await cli(base, ['browser', 'recording', 'list']);
    assert.equal(usage.code, 64);
    assert.match(usage.out, /usage: rooks browser recording get/);
  });
});

test('rooks browser annotations get|resolve|dismiss take the routes of browser_annotations_get|resolve', async () => {
  await withDaemon(async (base, seen) => {
    const routes = () => seen.map((s) => `${s.method} ${s.url}`);
    for (const [args, route] of [
      [['browser', 'annotations', 'get'], 'GET /api/native-browser/annotations'],
      [['browser', 'annotations', 'get', '--batch', 'bab-1', '--status', 'resolved'], 'GET /api/native-browser/annotations?batch=bab-1&status=resolved'],
      [['browser', 'annotations', 'get', 'ba-1'], 'GET /api/native-browser/annotations/ba-1'],
      [['browser', 'annotations', 'resolve', 'ba-1', '--summary', 'done'], 'POST /api/native-browser/annotations/ba-1/resolve'],
      [['browser', 'annotations', 'dismiss', 'ba-2', '--reason', 'no'], 'POST /api/native-browser/annotations/ba-2/resolve'],
    ] as const) {
      const run = await cli(base, [...args]);
      assert.equal(run.code, 0, run.out);
      assert.ok(routes().includes(route), `${route} not in ${routes().join(', ')}`);
    }
    const bodies = seen.filter((s) => s.method === 'POST').map((s) => s.body);
    assert.deepEqual(bodies.slice(-2), [{ status: 'resolved', summary: 'done' }, { status: 'dismissed', reason: 'no' }]);
    const usage = await cli(base, ['browser', 'annotations', 'resolve', 'ba-1']);
    assert.equal(usage.code, 64);
    assert.match(usage.out, /usage: rooks browser annotations/);
  });
});

test('rooks agent rename takes the same route as agent_rename', async () => {
  await withDaemon(async (base, seen) => {
    const run = await cli(base, ['agent', 'rename', 'a.b', 'c.d']);
    assert.equal(run.code, 0, run.out);
    const hit = seen.find((s) => `${s.method} ${s.url}` === 'POST /api/agents/a.b/rename');
    assert.ok(hit, seen.map((s) => `${s.method} ${s.url}`).join(', '));
    assert.deepEqual(hit.body, { newName: 'c.d' });
    const usage = await cli(base, ['agent', 'rename', 'a.b']);
    assert.equal(usage.code, 64);
    assert.match(usage.out, /usage: rooks agent rename/);
  });
});

test('rooks agent trash takes the same routes as agent_trash_*, purge included', async () => {
  await withDaemon(async (base, seen) => {
    for (const [argv, route] of [
      [['agent', 'trash', 'list', '--json'], 'GET /api/agent-trash'],
      [['agent', 'trash', 'restore', '20261028-101500000-a.b'], 'POST /api/agent-trash/20261028-101500000-a.b/restore'],
      [['agent', 'trash', 'purge', '20261028-101500000-a.b'], 'DELETE /api/agent-trash/20261028-101500000-a.b'],
    ] as const) {
      seen.length = 0;
      const run = await cli(base, [...argv]);
      assert.equal(run.code, 0, run.out);
      assert.ok(seen.some((s) => `${s.method} ${s.url}` === route), seen.map((s) => `${s.method} ${s.url}`).join(', '));
    }
    const usage = await cli(base, ['agent', 'trash', 'restore']);
    assert.equal(usage.code, 64);
    assert.match(usage.out, /usage: rooks agent trash/);
  });
});

test('rooks agent doc takes the same routes as agent_doc_*, content from --file or stdin', async () => {
  await withDaemon(async (base, seen) => {
    const routes = async (argv: string[], input?: string) => {
      seen.length = 0;
      const run = await cli(base, argv, {}, input);
      assert.equal(run.code, 0, run.out);
      return { run, hits: seen.map((s) => `${s.method} ${s.url}`), bodies: seen.map((s) => s.body) };
    };
    assert.deepEqual((await routes(['agent', 'doc', 'list', 'a.b'])).hits, ['GET /api/agents/a.b/docs']);
    const get = await routes(['agent', 'doc', 'get', 'a.b', 'SOUL.md']);
    assert.deepEqual(get.hits, ['GET /api/agents/a.b/docs/SOUL.md?format=json']);
    assert.equal(get.run.out, 'body');
    const piped = await routes(['agent', 'doc', 'put', 'a.b', 'SOUL.md'], '# from stdin');
    assert.deepEqual(piped.hits, ['PUT /api/agents/a.b/docs/SOUL.md']);
    assert.deepEqual(piped.bodies, [{ content: '# from stdin' }]);
    const file = join(mkdtempSync(join(tmpdir(), 'rooks-doc-')), 'SOUL.md');
    writeFileSync(file, '# from a file');
    const fromFile = await routes(['agent', 'doc', 'put', 'a.b', 'SOUL.md', '--file', file]);
    assert.deepEqual(fromFile.bodies, [{ content: '# from a file' }]);
    assert.deepEqual((await routes(['agent', 'doc', 'rm', 'a.b', 'SOUL.md'])).hits, ['DELETE /api/agents/a.b/docs/SOUL.md']);
    seen.length = 0;
    const empty = await cli(base, ['agent', 'doc', 'put', 'a.b', 'SOUL.md'], {}, '  \n');
    assert.equal(empty.code, 64);
    assert.equal(seen.length, 0);
    const usage = await cli(base, ['agent', 'doc', 'get', 'a.b']);
    assert.equal(usage.code, 64);
    assert.match(usage.out, /usage: rooks agent doc/);
  });
});

test('agent_doc_put refuses empty content instead of wiping the doc', async () => {
  await withDaemon(async (base, seen) => {
    const [reply] = await session(base, [{ method: 'tools/call', params: { name: 'agent_doc_put', arguments: { name: 'a', file: 'SOUL.md', content: ' ' } } }]);
    assert.equal(reply!.result?.isError, true);
    assert.equal(seen.length, 0);
  });
});

test('agent doc put fails loudly on a daemon that stored an empty doc (older than the client)', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'SOUL.md', size: 0, modified: 1 }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const [reply] = await session(base, [{ method: 'tools/call', params: { name: 'agent_doc_put', arguments: { name: 'a', file: 'SOUL.md', content: '# me' } } }]);
    assert.equal(reply!.result?.isError, true);
    assert.match(reply!.result?.content?.[0]?.text ?? '', /older than this tool/);
    const run = await cli(base, ['agent', 'doc', 'put', 'a', 'SOUL.md'], {}, '# me');
    assert.equal(run.code, 2);
    assert.match(run.out, /older than this CLI/);
  } finally { server.closeAllConnections(); server.close(); }
});

test('agent_update refuses an empty update', async () => {
  await withDaemon(async (base) => {
    const [reply] = await session(base, [{ method: 'tools/call', params: { name: 'agent_update', arguments: { name: 'a' } } }]);
    assert.equal(reply!.result?.isError, true);
  });
});

test('mission_spawn: from a mission every spawn delegates, overrides included; outside one they take the CLI route', async () => {
  await withDaemon(async (base, seen) => {
    const args = { agent_name: 'a', mission: 'go', model: 'm', backend: 'b', extra_skills: ['s'], idempotency_key: 'k', title: 'Volet A' };
    await session(base, [{ method: 'tools/call', params: { name: 'mission_spawn', arguments: args } }], true);
    // TIM-0074: a mission token never holds `missions:spawn`, so `/api/missions` was a certain 403.
    assert.equal(seen.some((s) => s.url === '/api/missions'), false);
    const delegated = seen.find((s) => s.url === '/api/missions/delegate');
    assert.ok(delegated, 'a spawn from a mission must use /api/missions/delegate');
    assert.deepEqual(delegated.body, args);
    seen.length = 0;
    await session(base, [{ method: 'tools/call', params: { name: 'mission_spawn', arguments: { agent_name: 'a', mission: 'go' } } }], true);
    assert.deepEqual(seen.find((s) => s.url === '/api/missions/delegate')?.body, { agent_name: 'a', mission: 'go' });
    seen.length = 0;
    await session(base, [{ method: 'tools/call', params: { name: 'mission_spawn', arguments: { agent_name: 'a', mission: 'go', model: 'm', extra_skills: ['s'], title: 'Volet A' } } }]);
    const withOverrides = seen.find((s) => s.url === '/api/missions');
    assert.ok(withOverrides, 'outside a mission, overrides use /api/missions');
    assert.equal(withOverrides.body.agent, 'a');
    assert.equal(withOverrides.body.input, 'go');
    assert.equal(withOverrides.body.model_override, 'm');
    assert.deepEqual(withOverrides.body.extra_skills, ['s']);
    assert.equal(withOverrides.body.title, 'Volet A', 'the preset title rides with the spawn');
  });
});

test('rooks spawn: from a mission it delegates with the MCP\'s fields, outside it uses /api/missions', async () => {
  await withDaemon(async (base, seen) => {
    await cli(base, ['spawn', 'a', 'go'], { ROOKS_MISSION_ID: 'mission-parent', ROOKS_AGENT: 'sender' });
    // TIM-0074: a mission token never holds `missions:spawn`, so `/api/missions` was a certain 403.
    assert.equal(seen.some((s) => s.url === '/api/missions'), false);
    const delegated = seen.find((s) => s.url === '/api/missions/delegate');
    assert.ok(delegated, 'a spawn from a mission must use /api/missions/delegate');
    assert.deepEqual(delegated.body, { agent_name: 'a', mission: 'go' });
    assert.equal('source_channel' in delegated.body, false, 'the delegate body is .strict()');
    assert.equal('trace_id' in delegated.body, false, 'the parent inherits the trace server-side');
    seen.length = 0;
    await cli(base, ['spawn', 'a', 'go', '--model', 'm', '--backend', 'b', '--extra-skills', 's', '--idempotency-key', 'k', '--title', 'Volet A'], { ROOKS_MISSION_ID: 'mission-parent' });
    assert.equal(seen.some((s) => s.url === '/api/missions'), false);
    assert.deepEqual(seen.find((s) => s.url === '/api/missions/delegate')?.body, {
      agent_name: 'a', mission: 'go', model: 'm', backend: 'b', extra_skills: ['s'], idempotency_key: 'k', title: 'Volet A',
    });
    seen.length = 0;
    await cli(base, ['spawn', 'a', 'go', '--model', 'm', '--title', 'Volet A']);
    const withOverrides = seen.find((s) => s.url === '/api/missions');
    assert.ok(withOverrides, 'outside a mission, overrides use /api/missions');
    assert.equal(withOverrides.body.agent, 'a');
    assert.equal(withOverrides.body.input, 'go');
    assert.equal(withOverrides.body.model_override, 'm');
    assert.equal(withOverrides.body.title, 'Volet A');
  });
});

test('kanban_add relays extra_* and accepts any backend id', async () => {
  await withDaemon(async (base, seen) => {
    const [list] = await session(base, [{ method: 'tools/list' }]);
    const props = list!.result!.tools!.find((t) => t.name === 'kanban_add')!.inputSchema.properties as Record<string, { enum?: unknown }>;
    assert.equal(props.backend_override!.enum, undefined, 'backend ids come from the live catalogue, not a frozen enum');
    await session(base, [{ method: 'tools/call', params: { name: 'kanban_add', arguments: { title: 't', agent_name: 'a', extra_skills: ['s'], extra_mcp_servers: ['m'], extra_allowed_tools: ['Bash(rooks:*)'] } } }]);
    const post = seen.find((s) => s.url === '/api/tasks')!;
    assert.deepEqual(post.body.extra_skills, ['s']);
    assert.deepEqual(post.body.extra_mcp_servers, ['m']);
    assert.deepEqual(post.body.extra_allowed_tools, ['Bash(rooks:*)']);
  });
});

test('agent_create exposes every config field agent_update does', async () => {
  await withDaemon(async (base) => {
    const [list] = await session(base, [{ method: 'tools/list' }]);
    const tools = list!.result!.tools!;
    const create = Object.keys(tools.find((t) => t.name === 'agent_create')!.inputSchema.properties);
    for (const key of ['permission_mode', 'skills', 'mcp_servers', 'allowed_tools', 'disallowed_tools', 'excluded_mcp_servers', 'memory_scope']) {
      assert.ok(create.includes(key), `agent_create lacks ${key}`);
    }
  });
});

test('workflow_node_done closes the node from the mission env, or explicit ids for a coordinator', async () => {
  await withDaemon(async (base, seen) => {
    // Node id from the mission env, like the CLI reads ROOKS_WORKFLOW_NODE_ID.
    await session(base, [{ method: 'tools/call', params: { name: 'workflow_node_done', arguments: { output: { k: 'v' }, route: 'ok' } } }], true, { ROOKS_WORKFLOW_RUN_ID: 'run1', ROOKS_WORKFLOW_NODE_ID: 'node1' });
    const done = seen.find((s) => s.url === '/api/workflows/runs/run1/nodes/node1/done');
    assert.ok(done, 'env-driven node done posts to the node route');
    assert.deepEqual(done.body, { output: { k: 'v' }, route: 'ok' });
    seen.length = 0;
    // Coordinator path: a mission with no node id passes both ids explicitly.
    await session(base, [{ method: 'tools/call', params: { name: 'workflow_node_done', arguments: { output: {}, run_id: 'run2', node_id: 'node2' } } }], true);
    assert.ok(seen.find((s) => s.url === '/api/workflows/runs/run2/nodes/node2/done'), 'explicit ids close the node from a coordinator mission');
    seen.length = 0;
    // No node id anywhere: an error, no daemon call.
    const [reply] = await session(base, [{ method: 'tools/call', params: { name: 'workflow_node_done', arguments: { output: {} } } }], true);
    assert.equal(reply!.result?.isError, true);
    assert.equal(seen.length, 0);
  });
});

test('a 403 from an override gate surfaces its reason, not a bare "forbidden"', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden', reason: 'permission_mode is not allowed: bypassPermissions' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const [reply] = await session(base, [{ method: 'tools/call', params: { name: 'agent_create', arguments: { name: 'a', system_prompt: 'p', permission_mode: 'bypassPermissions' } } }]);
    assert.equal(reply!.result?.isError, true);
    assert.match(reply!.result?.content?.[0]?.text ?? '', /permission_mode is not allowed: bypassPermissions/);
  } finally { server.closeAllConnections(); server.close(); }
});
