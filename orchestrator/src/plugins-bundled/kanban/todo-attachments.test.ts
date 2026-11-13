/**
 * Files attached to an idea of the TO DO notebook: the routes refuse first
 * (anonymous, no Kanban permission, someone else's idea, a malformed id, too
 * big, wrong type), then store, list, serve and delete; the files go with
 * their idea, and a promotion hands the task its own copy.
 */
import '../../test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import express from 'express';
import { dbApi } from '../../db.js';
import { registerRoutes } from './routes.js';
import { registerRoutes as registerTodoRoutes } from './project-todo-routes.js';
import { registerAttachmentRoutes } from './attachment-routes.js';
import {
  listTaskAttachments, taskAttachmentsWithInherited, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, purgeOrphanTodoAttachments, todoAttachmentsRoot,
  watchTodoDeletions,
} from '../../attachments.js';
import { composeTaskPrompt } from '../../dispatcher.js';
// `POST /api/tasks` (the promotion) resolves the task's LLM: an active backend must exist.
await import('../../../tests/helpers/claude-provider.js');

const OWNER = randomUUID();
const STRANGER = randomUUID();
const ACTORS: Record<string, { actor: string; permissions: string[] }> = {
  owner: { actor: OWNER, permissions: ['kanban:read', 'kanban:write'] },
  reader: { actor: OWNER, permissions: ['kanban:read'] },
  nokanban: { actor: OWNER, permissions: ['missions:read'] },
  stranger: { actor: STRANGER, permissions: ['kanban:read', 'kanban:write'] },
};

const app = express();
app.use((req, _res, next) => {
  const who = ACTORS[req.header('x-test-as') ?? ''];
  if (who) req.auth = { kind: 'api-token', isSuperadmin: false, actorId: who.actor, permissions: who.permissions };
  next();
});
app.use(express.json({ limit: '25mb' }));
registerRoutes(app);
registerTodoRoutes(app);
registerAttachmentRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const stopWatching = watchTodoDeletions();
after(() => { stopWatching(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

function call(method: string, path: string, as: string | null, body?: unknown) {
  const headers: Record<string, string> = as ? { 'x-test-as': as } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
const upload = (todo: number | string, name: string, bytes: Buffer, as: string | null = 'owner') =>
  call('POST', `/api/project-todo/${todo}/attachments`, as, { name, data: bytes.toString('base64') });

function seed(owner = OWNER): number {
  return dbApi.insertProjectTodo({ text: 'Attachment witness', ownerUserId: owner }).id;
}
const filesOf = (todo: number): string[] => {
  try { return readdirSync(join(todoAttachmentsRoot(), String(todo))); } catch { return []; }
};

test('anonymous: 401 on every route, nothing written', async () => {
  const todo = seed();
  const own = await (await upload(todo, 'mockup.png', PNG)).json() as { attachment: { id: string } };
  for (const [method, path] of [
    ['GET', `/api/project-todo/${todo}/attachments`],
    ['GET', `/api/project-todo/${todo}/attachments/${own.attachment.id}`],
    ['DELETE', `/api/project-todo/${todo}/attachments/${own.attachment.id}`],
  ] as const) assert.equal((await call(method, path, null)).status, 401, `${method} ${path}`);
  assert.equal((await upload(todo, 'other.png', PNG, null)).status, 401);
  assert.equal(filesOf(todo).length, 1);
});

test('an account without the Kanban permission: 403; reading is not writing', async () => {
  const todo = seed();
  const refused = await upload(todo, 'mockup.png', PNG, 'nokanban');
  assert.equal(refused.status, 403);
  assert.match(JSON.stringify(await refused.json()), /kanban:write/);
  assert.equal((await call('GET', `/api/project-todo/${todo}/attachments`, 'nokanban')).status, 403);
  assert.equal((await upload(todo, 'mockup.png', PNG, 'reader')).status, 403);
  assert.equal((await call('GET', `/api/project-todo/${todo}/attachments`, 'reader')).status, 200);
  const theirs = await (await upload(todo, 'mockup.png', PNG)).json() as { attachment: { id: string } };
  assert.equal((await call('DELETE', `/api/project-todo/${todo}/attachments/${theirs.attachment.id}`, 'reader')).status, 403);
  assert.equal(filesOf(todo).length, 1);
});

test('someone else\'s idea answers 404 on the four routes, like an idea that does not exist', async () => {
  const todo = seed(STRANGER);
  assert.equal((await upload(todo, 'mockup.png', PNG, 'owner')).status, 404);
  assert.equal((await call('GET', `/api/project-todo/${todo}/attachments`, 'owner')).status, 404);
  assert.equal((await upload(987_654_321, 'mockup.png', PNG)).status, 404);
  const theirs = await (await upload(todo, 'mockup.png', PNG, 'stranger')).json() as { attachment: { id: string } };
  const one = `/api/project-todo/${todo}/attachments/${theirs.attachment.id}`;
  const fetched = await call('GET', one, 'owner');
  assert.equal(fetched.status, 404);
  assert.equal((await fetched.json() as { code: string }).code, 'todo_not_found');
  assert.equal((await call('DELETE', one, 'owner')).status, 404);
  assert.equal(filesOf(todo).length, 1);
});

test('an idea id that is not a plain positive integer is refused with 400, so is a malformed attachment id', async () => {
  const todo = seed();
  for (const bad of ['abc', '0x10', '1e3', '0', '-1', '01', '1.5', '..%2F..']) {
    assert.equal((await upload(bad, 'mockup.png', PNG)).status, 400, bad);
    assert.equal((await call('GET', `/api/project-todo/${bad}/attachments`, 'owner')).status, 400, bad);
  }
  assert.equal((await call('GET', `/api/project-todo/${todo}/attachments/not-a-uuid`, 'owner')).status, 400);
  assert.equal((await call('DELETE', `/api/project-todo/${todo}/attachments/..%2F..%2Fetc`, 'owner')).status, 400);
  assert.equal((await call('POST', `/api/project-todo/${todo}/attachments`, 'owner', { name: 'a.png' })).status, 400);
  assert.equal((await call('POST', `/api/project-todo/${todo}/attachments`, 'owner', { name: 'a.txt', data: 'not base64 !' })).status, 400);
  assert.equal((await call('POST', `/api/project-todo/${todo}/attachments`, 'owner', { name: 'a.png', data: 'AA==', path: '/etc' })).status, 400);
  assert.deepEqual(filesOf(todo), []);
});

test('a type outside the list, or bytes that are not of their type, are refused with 415', async () => {
  const todo = seed();
  for (const name of ['payload.exe', 'drawing.svg', 'page.html', 'install.sh', 'archive.zip', 'no-extension']) {
    const response = await upload(todo, name, PNG);
    assert.equal(response.status, 415, name);
    assert.equal((await response.json() as { code: string }).code, 'attachment_type_refused', name);
  }
  const disguised = await upload(todo, 'mockup.png', Buffer.from('<script>alert(1)</script>'));
  assert.equal(disguised.status, 415);
  assert.equal((await disguised.json() as { code: string }).code, 'attachment_content_mismatch');
  assert.equal((await upload(todo, 'repro.py', Buffer.from([0x4d, 0x5a, 0x00, 0x00]))).status, 415);
  assert.deepEqual(filesOf(todo), []);
});

test('a file over the bound, or one past the quota, is refused with 413', async () => {
  const todo = seed();
  const big = await upload(todo, 'huge.txt', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x41));
  assert.equal(big.status, 413);
  assert.equal((await big.json() as { code: string }).code, 'attachment_too_large');
  assert.deepEqual(filesOf(todo), []);
  for (let i = 0; i < MAX_ATTACHMENTS; i++) assert.equal((await upload(todo, `shot-${i}.png`, PNG)).status, 201);
  const over = await upload(todo, 'one-more.png', PNG);
  assert.equal(over.status, 413);
  const refusal = await over.json() as { code: string; error: string };
  assert.equal(refusal.code, 'attachment_quota');
  assert.match(refusal.error, /An idea holds at most/);
});

test('nominal: upload, list, serve with the right type, delete; the notebook counts the files', async () => {
  const todo = seed();
  const created = await upload(todo, '../../etc/mockup.png', PNG);
  assert.equal(created.status, 201);
  const { attachment } = await created.json() as { attachment: Record<string, unknown> };
  assert.deepEqual(Object.keys(attachment).sort(), ['created_at', 'id', 'kind', 'mime', 'name', 'size', 'todo_id']);
  assert.equal(attachment.todo_id, todo);
  assert.equal(attachment.name, 'mockup.png');
  assert.equal((await upload(todo, 'trace.log', Buffer.from('boom'))).status, 201);

  const listed = await (await call('GET', `/api/project-todo/${todo}/attachments`, 'reader')).json() as { attachments: { id: string; name: string }[] };
  assert.deepEqual(listed.attachments.map((a) => a.name), ['mockup.png', 'trace.log']);
  assert.doesNotMatch(JSON.stringify(listed), /uploads/);

  const image = await call('GET', `/api/project-todo/${todo}/attachments/${attachment.id}`, 'reader');
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
  const log = await call('GET', `/api/project-todo/${todo}/attachments/${listed.attachments[1]!.id}`, 'reader');
  assert.match(log.headers.get('content-disposition') ?? '', /^attachment;/);
  assert.match(log.headers.get('content-security-policy') ?? '', /sandbox/);
  await log.arrayBuffer();

  const notebook = await (await call('GET', '/api/project-todo?status=all', 'reader')).json() as { items: { id: number; attachment_count: number }[] };
  assert.equal(notebook.items.find((i) => i.id === todo)?.attachment_count, 2);
  const bare = seed();
  const again = await (await call('GET', '/api/project-todo?status=all', 'reader')).json() as { items: { id: number; attachment_count: number }[] };
  assert.equal(again.items.find((i) => i.id === bare)?.attachment_count, 0);

  assert.equal((await call('DELETE', `/api/project-todo/${todo}/attachments/${attachment.id}`, 'owner')).status, 200);
  assert.equal((await call('GET', `/api/project-todo/${todo}/attachments/${attachment.id}`, 'owner')).status, 404);
  assert.equal((await call('DELETE', `/api/project-todo/${todo}/attachments/${attachment.id}`, 'owner')).status, 404);
});

test('deleting the idea deletes its files', async () => {
  const todo = seed();
  await upload(todo, 'mockup.png', PNG);
  assert.ok(existsSync(join(todoAttachmentsRoot(), String(todo))));
  assert.equal((await call('DELETE', `/api/project-todo/${todo}`, 'owner')).status, 200);
  assert.equal(existsSync(join(todoAttachmentsRoot(), String(todo))), false);
});

test('the folder of an idea deleted while nobody listened is swept, a living idea\'s is kept', async () => {
  const living = seed();
  await upload(living, 'mockup.png', PNG);
  const gone = 900_000_001;
  mkdirSync(join(todoAttachmentsRoot(), String(gone), randomUUID()), { recursive: true });
  mkdirSync(join(todoAttachmentsRoot(), 'not-an-idea'), { recursive: true });
  const removed = purgeOrphanTodoAttachments((id) => dbApi.getProjectTodo(id) !== undefined);
  assert.ok(removed.includes(gone));
  assert.equal(existsSync(join(todoAttachmentsRoot(), String(gone))), false);
  // A folder that is not an idea id is not ours to judge.
  assert.ok(existsSync(join(todoAttachmentsRoot(), 'not-an-idea')));
  assert.equal(filesOf(living).length, 1);
});

test('a promotion copies the idea\'s files into the task, whose brief names them; the copy outlives the idea', async () => {
  const todo = seed();
  await upload(todo, 'mockup.png', PNG);
  await upload(todo, 'trace.log', Buffer.from('boom'));
  const promoted = await call('POST', `/api/project-todo/${todo}/promote`, 'owner', { agent_name: 'witness.coder' });
  assert.equal(promoted.status, 201);
  const { task } = await promoted.json() as { task: { id: string } };
  const copies = listTaskAttachments(task.id);
  assert.deepEqual(copies.map((a) => a.name), ['mockup.png', 'trace.log']);
  // What the dispatcher hands the agent (`taskAttachmentsWithInherited`): the task's own copies.
  const prompt = composeTaskPrompt(task.id, 'Brief', taskAttachmentsWithInherited(dbApi.getTask(task.id)!), '');
  for (const f of copies) assert.ok(prompt.text.includes(`\`${f.path}\``), f.name);
  assert.equal((await call('DELETE', `/api/project-todo/${todo}`, 'owner')).status, 200);
  assert.deepEqual(filesOf(todo), []);
  assert.equal(listTaskAttachments(task.id).length, 2);
});

test('an idea without files promotes as before, with no folder for its task', async () => {
  const todo = seed();
  const promoted = await call('POST', `/api/project-todo/${todo}/promote`, 'owner', { agent_name: 'witness.coder' });
  assert.equal(promoted.status, 201);
  const { task } = await promoted.json() as { task: { id: string } };
  assert.deepEqual(listTaskAttachments(task.id), []);
});
