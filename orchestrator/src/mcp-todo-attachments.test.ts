/**
 * The MCP tools of an idea's files (`bin/rooks-mcp-catalog.mjs`): a local
 * agent reads a file by its path on this machine and gets an absolute path
 * back to open; a remote one never sends nor receives a path.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadMcpCatalog } from './remote-mcp/catalog.js';

type Sent = { method: string; path: string; body?: unknown };

function recorder(answer: (sent: Sent) => unknown) {
  const sent: Sent[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    const one = { method, path, body };
    sent.push(one);
    return answer(one);
  };
  return { sent, call };
}

const local = (call: (m: string, p: string, b?: unknown) => Promise<unknown>) => ({ call, env: {}, hostFiles: true });
const remote = (call: (m: string, p: string, b?: unknown) => Promise<unknown>) => ({ call, env: {}, hostFiles: false });

test('the three tools are listed, with a title', async () => {
  const { TOOLS } = await loadMcpCatalog();
  for (const name of ['project_todo_attachments_list', 'project_todo_attachments_add', 'project_todo_attachments_remove']) {
    const tool = TOOLS.find((t) => t.name === name);
    assert.ok(tool?.title, name);
  }
});

test('list: a local agent gets the path of a file that is really there, a remote one never does', async () => {
  const { runTool } = await loadMcpCatalog();
  const there = { id: randomUUID(), todo_id: 42, name: 'shot.png', size: 3, mime: 'image/png', kind: 'image', created_at: 1 };
  const missing = { ...there, id: randomUUID(), name: 'gone.png' };
  const folder = join(process.env.ROOKS_HOME!, 'uploads', 'todos', '42', there.id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'shot.png'), 'png');
  const { sent, call } = recorder(() => ({ attachments: [there, missing] }));
  const files = await runTool('project_todo_attachments_list', { id: 42 }, local(call)) as Array<{ name: string; path?: string }>;
  assert.deepEqual(sent, [{ method: 'GET', path: '/api/project-todo/42/attachments', body: undefined }]);
  assert.equal(files[0]!.path, join(folder, 'shot.png'));
  assert.equal(files[1]!.path, undefined);
  const far = await runTool('project_todo_attachments_list', { id: 42 }, remote(call)) as Array<{ path?: string }>;
  assert.ok(far.every((f) => f.path === undefined));
});

test('add: a local file is read here and sent as base64 under its own name', async () => {
  const { runTool } = await loadMcpCatalog();
  const dir = mkdtempSync(join(tmpdir(), 'mcp-todo-file-'));
  const file = join(dir, 'trace.log');
  writeFileSync(file, 'boom');
  const { sent, call } = recorder(() => ({ attachment: { id: 'x' } }));
  assert.deepEqual(await runTool('project_todo_attachments_add', { id: 7, path: file }, local(call)), { id: 'x' });
  assert.deepEqual(sent[0], {
    method: 'POST', path: '/api/project-todo/7/attachments',
    body: { name: 'trace.log', data: Buffer.from('boom').toString('base64') },
  });
  await runTool('project_todo_attachments_add', { id: 7, path: file, name: 'renamed.log' }, local(call));
  assert.equal((sent[1]!.body as { name: string }).name, 'renamed.log');
});

test('add: refused before any call for a relative path, a folder, a file over 15 MB, or a path sent remotely', async () => {
  const { runTool } = await loadMcpCatalog();
  const dir = mkdtempSync(join(tmpdir(), 'mcp-todo-file-'));
  const big = join(dir, 'huge.log');
  writeFileSync(big, '');
  truncateSync(big, 15 * 1024 * 1024 + 1);
  const { sent, call } = recorder(() => ({ attachment: {} }));
  await assert.rejects(runTool('project_todo_attachments_add', { id: 7, path: 'trace.log' }, local(call)), /absolute/);
  await assert.rejects(runTool('project_todo_attachments_add', { id: 7, path: dir }, local(call)), /not a file/);
  await assert.rejects(runTool('project_todo_attachments_add', { id: 7, path: big }, local(call)), /too large/);
  await assert.rejects(runTool('project_todo_attachments_add', { id: 7, path: big }, remote(call)), /remote/);
  await assert.rejects(runTool('project_todo_attachments_add', { id: 7 }, local(call)), /path/);
  await assert.rejects(runTool('project_todo_attachments_add', { id: 7, data: 'AA==' }, remote(call)), /name/);
  assert.deepEqual(sent, []);
  await runTool('project_todo_attachments_add', { id: 7, data: 'AA==', name: 'a.txt' }, remote(call));
  assert.deepEqual(sent[0]!.body, { name: 'a.txt', data: 'AA==' });
});

test('remove: one DELETE, the ids encoded', async () => {
  const { runTool } = await loadMcpCatalog();
  const { sent, call } = recorder(() => ({ ok: true }));
  assert.deepEqual(await runTool('project_todo_attachments_remove', { id: 7, attachment_id: '../x' }, local(call)), { ok: true });
  assert.deepEqual(sent, [{ method: 'DELETE', path: '/api/project-todo/7/attachments/..%2Fx', body: undefined }]);
});
