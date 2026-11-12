/**
 * Files attached to a task: the routes refuse first (anonymous, no Kanban
 * permission, someone else's task, too big, wrong type, `..`), then store,
 * list, serve and delete; the files go with their task, reach the iterations
 * of its chain, and are announced to the agent by their absolute path.
 */
import '../../test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { after, test } from 'node:test';
import express from 'express';
import { db, dbApi } from '../../db.js';
import { registerRoutes } from './routes.js';
import { registerAttachmentRoutes } from './attachment-routes.js';
import {
  MAX_TASK_ATTACHMENT_BYTES, MAX_TASK_ATTACHMENTS, purgeOrphanTaskAttachments, safeTaskAttachmentName,
  taskAttachmentsRoot, taskAttachmentsWithInherited, watchTaskDeletions,
} from '../../attachments.js';
import { composeTaskPrompt } from '../../dispatcher.js';
// `GET /api/tasks` resolves each task's LLM: an active backend must exist.
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
registerAttachmentRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const stopWatching = watchTaskDeletions();
after(() => { stopWatching(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');

function call(method: string, path: string, as: string | null, body?: unknown) {
  const headers: Record<string, string> = as ? { 'x-test-as': as } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
const upload = (task: string, name: string, bytes: Buffer, as: string | null = 'owner') =>
  call('POST', `/api/tasks/${task}/attachments`, as, { name, data: bytes.toString('base64'), mime: 'image/png' });

function seed(owner = OWNER): string {
  const id = randomUUID();
  dbApi.createTask(id, 'Attachment witness', 'witness', { ownerUserId: owner });
  return id;
}
const filesOf = (task: string): string[] => {
  try { return readdirSync(join(taskAttachmentsRoot(), task)); } catch { return []; }
};

test('anonymous: 401 on every route, nothing written', async () => {
  const task = seed();
  const own = await (await upload(task, 'mockup.png', PNG)).json() as { attachment: { id: string } };
  for (const [method, path] of [
    ['GET', `/api/tasks/${task}/attachments`],
    ['GET', `/api/tasks/${task}/attachments/${own.attachment.id}`],
    ['DELETE', `/api/tasks/${task}/attachments/${own.attachment.id}`],
  ] as const) assert.equal((await call(method, path, null)).status, 401, `${method} ${path}`);
  assert.equal((await upload(task, 'other.png', PNG, null)).status, 401);
  assert.equal(filesOf(task).length, 1);
});

test('an account without the Kanban permission: 403 with the missing permission named', async () => {
  const task = seed();
  const refused = await upload(task, 'mockup.png', PNG, 'nokanban');
  assert.equal(refused.status, 403);
  assert.match(JSON.stringify(await refused.json()), /kanban:write/);
  assert.equal((await call('GET', `/api/tasks/${task}/attachments`, 'nokanban')).status, 403);
  // Reading the Kanban is not changing it.
  assert.equal((await upload(task, 'mockup.png', PNG, 'reader')).status, 403);
  assert.equal((await call('GET', `/api/tasks/${task}/attachments`, 'reader')).status, 200);
  assert.deepEqual(filesOf(task), []);
});

test('someone else\'s task answers 404, like a task that does not exist', async () => {
  const task = seed(STRANGER);
  assert.equal((await upload(task, 'mockup.png', PNG, 'owner')).status, 404);
  assert.equal((await call('GET', `/api/tasks/${task}/attachments`, 'owner')).status, 404);
  assert.equal((await upload(randomUUID(), 'mockup.png', PNG)).status, 404);
  const theirs = await (await upload(task, 'mockup.png', PNG, 'stranger')).json() as { attachment: { id: string } };
  assert.equal((await call('GET', `/api/tasks/${task}/attachments/${theirs.attachment.id}`, 'owner')).status, 404);
  assert.equal((await call('DELETE', `/api/tasks/${task}/attachments/${theirs.attachment.id}`, 'owner')).status, 404);
  assert.equal(filesOf(task).length, 1);
});

test('a file over the bound is refused with 413, nothing written', async () => {
  const task = seed();
  const big = Buffer.alloc(MAX_TASK_ATTACHMENT_BYTES + 1, 0x41);
  const response = await upload(task, 'huge.txt', big);
  assert.equal(response.status, 413);
  assert.equal((await response.json() as { code: string }).code, 'attachment_too_large');
  assert.deepEqual(filesOf(task), []);
});

test('a type outside the list, or bytes that are not of their type, are refused with 415', async () => {
  const task = seed();
  for (const name of ['payload.exe', 'drawing.svg', 'page.html', 'install.sh', 'archive.zip', 'no-extension']) {
    const response = await upload(task, name, PNG);
    assert.equal(response.status, 415, name);
    assert.equal((await response.json() as { code: string }).code, 'attachment_type_refused', name);
  }
  // A script renamed `.png` is not served inline as an image.
  const disguised = await upload(task, 'mockup.png', Buffer.from('<script>alert(1)</script>'));
  assert.equal(disguised.status, 415);
  assert.equal((await disguised.json() as { code: string }).code, 'attachment_content_mismatch');
  assert.equal((await upload(task, 'notes.txt', Buffer.from([0x4d, 0x5a, 0x00, 0x00]))).status, 415);
  assert.deepEqual(filesOf(task), []);
});

test('source and config files are taken as inert text: text/plain, a download, sandboxed', async () => {
  const task = seed();
  for (const name of ['repro.py', 'main.ts', 'bundle.js', 'build.cjs', 'mod.mjs', 'pom.xml', 'Cargo.toml', 'php.ini', 'site.css']) {
    const created = await upload(task, name, Buffer.from('print("hello")\n'));
    assert.equal(created.status, 201, name);
    const { attachment } = await created.json() as { attachment: { id: string; mime: string } };
    assert.equal(attachment.mime, 'text/plain', name);
    const served = await call('GET', `/api/tasks/${task}/attachments/${attachment.id}`, 'owner');
    assert.match(served.headers.get('content-type') ?? '', /^text\/plain(;|$)/, name);
    assert.match(served.headers.get('content-disposition') ?? '', /^attachment;/, name);
    assert.match(served.headers.get('content-security-policy') ?? '', /sandbox/, name);
    await served.arrayBuffer();
  }
  // A binary renamed `.js` is not text.
  assert.equal((await upload(task, 'evil.js', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]))).status, 415);
});

test('malformed bodies and identifiers are refused with 400', async () => {
  const task = seed();
  assert.equal((await call('POST', `/api/tasks/${task}/attachments`, 'owner', { name: 'a.png' })).status, 400);
  assert.equal((await call('POST', `/api/tasks/${task}/attachments`, 'owner', { name: 'a.txt', data: 'not base64 !' })).status, 400);
  assert.equal((await call('POST', `/api/tasks/${task}/attachments`, 'owner', { name: 'a.png', data: 'AA==', path: '/etc' })).status, 400);
  assert.equal((await call('GET', `/api/tasks/..%2F../attachments`, 'owner')).status, 400);
  assert.equal((await call('GET', `/api/tasks/${task}/attachments/..%2F..%2Fetc`, 'owner')).status, 400);
  assert.equal((await call('GET', `/api/tasks/${task}/attachments/not-a-uuid`, 'owner')).status, 400);
});

test('a name carrying `..` and separators lands inside the task folder, under a harmless name', async () => {
  const task = seed();
  const response = await upload(task, '../../../etc/passwd.txt', Buffer.from('root:x:0:0'));
  assert.equal(response.status, 201);
  const { attachment } = await response.json() as { attachment: { name: string } };
  assert.equal(attachment.name, 'passwd.txt');
  assert.equal(filesOf(task).length, 1);
  assert.equal(safeTaskAttachmentName('..\\..\\evil name?.PDF', 'pdf'), 'evil name_.pdf');
  assert.equal(safeTaskAttachmentName('CON.txt', 'txt'), '_CON.txt');
  assert.equal(safeTaskAttachmentName('...txt', 'txt'), '_file.txt');
  assert.ok(safeTaskAttachmentName(`${'x'.repeat(300)}.docx`, 'docx').endsWith('.docx'));
});

test('nominal: upload, list, serve with the right type, delete', async () => {
  const task = seed();
  const created = await upload(task, 'mockup.png', PNG);
  assert.equal(created.status, 201);
  const { attachment } = await created.json() as { attachment: Record<string, unknown> };
  assert.deepEqual(Object.keys(attachment).sort(), ['created_at', 'id', 'kind', 'mime', 'name', 'size', 'task_id']);
  assert.equal(attachment.mime, 'image/png');
  assert.equal(attachment.kind, 'image');
  assert.equal(attachment.size, PNG.length);
  assert.equal(attachment.task_id, task);
  assert.equal((await upload(task, 'spec.pdf', PDF)).status, 201);
  assert.equal((await upload(task, 'notes.md', Buffer.from('# Notes'))).status, 201);

  const listed = await (await call('GET', `/api/tasks/${task}/attachments`, 'reader')).json() as { attachments: { id: string; name: string }[] };
  assert.deepEqual(listed.attachments.map((a) => a.name), ['mockup.png', 'spec.pdf', 'notes.md']);
  // No path in what leaves the daemon: it names the account's home.
  assert.doesNotMatch(JSON.stringify(listed), /uploads/);

  const image = await call('GET', `/api/tasks/${task}/attachments/${attachment.id}`, 'reader');
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.match(image.headers.get('content-disposition') ?? '', /^inline; filename="mockup.png"/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
  const forced = await call('GET', `/api/tasks/${task}/attachments/${attachment.id}?download=1`, 'reader');
  assert.match(forced.headers.get('content-disposition') ?? '', /^attachment;/);
  await forced.arrayBuffer();

  const pdf = listed.attachments[1]!;
  const pdfResponse = await call('GET', `/api/tasks/${task}/attachments/${pdf.id}`, 'reader');
  assert.equal(pdfResponse.headers.get('content-type'), 'application/pdf');
  assert.equal(pdfResponse.headers.get('content-security-policy'), null);
  await pdfResponse.arrayBuffer();
  const md = listed.attachments[2]!;
  const mdResponse = await call('GET', `/api/tasks/${task}/attachments/${md.id}`, 'reader');
  assert.match(mdResponse.headers.get('content-disposition') ?? '', /^attachment;/);
  assert.match(mdResponse.headers.get('content-security-policy') ?? '', /sandbox/);
  await mdResponse.arrayBuffer();

  assert.equal((await call('DELETE', `/api/tasks/${task}/attachments/${attachment.id}`, 'reader')).status, 403);
  assert.equal((await call('DELETE', `/api/tasks/${task}/attachments/${attachment.id}`, 'owner')).status, 200);
  assert.equal((await call('GET', `/api/tasks/${task}/attachments/${attachment.id}`, 'owner')).status, 404);
  assert.equal((await call('DELETE', `/api/tasks/${task}/attachments/${attachment.id}`, 'owner')).status, 404);
});

test('the task itself carries its files, the board their number', async () => {
  const task = seed();
  await upload(task, 'mockup.png', PNG);
  await upload(task, 'spec.pdf', PDF);
  const bare = seed();
  const detail = await (await call('GET', `/api/tasks/${task}`, 'owner')).json() as { task: { attachments: { name: string }[] } };
  assert.deepEqual(detail.task.attachments.map((a) => a.name), ['mockup.png', 'spec.pdf']);
  const board = await (await call('GET', '/api/tasks', 'owner')).json() as { tasks: { id: string; attachment_count: number }[] };
  assert.equal(board.tasks.find((t) => t.id === task)?.attachment_count, 2);
  assert.equal(board.tasks.find((t) => t.id === bare)?.attachment_count, 0);
});

test('a task holds a bounded number of files', async () => {
  const task = seed();
  for (let i = 0; i < MAX_TASK_ATTACHMENTS; i++) assert.equal((await upload(task, `shot-${i}.png`, PNG)).status, 201);
  const over = await upload(task, 'one-more.png', PNG);
  assert.equal(over.status, 413);
  assert.equal((await over.json() as { code: string }).code, 'attachment_quota');
});

test('deleting the task deletes its files', async () => {
  const task = seed();
  await upload(task, 'mockup.png', PNG);
  assert.ok(existsSync(join(taskAttachmentsRoot(), task)));
  const response = await fetch(`${base}/api/tasks/${task}`, { method: 'DELETE', headers: { 'x-test-as': 'owner' } });
  assert.equal(response.status, 200);
  assert.equal(existsSync(join(taskAttachmentsRoot(), task)), false);
});

test('the folder of a task deleted while nobody listened is swept, a living task\'s is kept', async () => {
  const living = seed();
  await upload(living, 'mockup.png', PNG);
  const gone = randomUUID();
  mkdirSync(join(taskAttachmentsRoot(), gone, randomUUID()), { recursive: true });
  const removed = purgeOrphanTaskAttachments((id) => dbApi.getTask(id) !== undefined);
  assert.ok(removed.includes(gone));
  assert.equal(existsSync(join(taskAttachmentsRoot(), gone)), false);
  assert.equal(filesOf(living).length, 1);
});

test('an iteration sees its root\'s files, and its agent is told their absolute paths', async () => {
  const root = seed();
  await upload(root, 'mockup.png', PNG);
  const iteration = randomUUID();
  dbApi.createTask(iteration, 'Witness [iter:2]', 'witness', { ownerUserId: OWNER, type: 'code' });
  db.prepare('UPDATE tasks SET verification_root_id = ? WHERE id = ?').run(root, iteration);
  await upload(iteration, 'fix.txt', Buffer.from('tighter spacing'));

  const files = taskAttachmentsWithInherited(dbApi.getTask(iteration)!);
  assert.deepEqual(files.map((f) => [f.name, f.task_id]), [['fix.txt', iteration], ['mockup.png', root]]);
  const detail = await (await call('GET', `/api/tasks/${iteration}`, 'owner')).json() as { task: { attachments: { task_id: string }[] } };
  assert.deepEqual(detail.task.attachments.map((a) => a.task_id), [iteration, root]);
  // The inherited file is served from its own task.
  const inherited = files[1]!;
  const served = await call('GET', `/api/tasks/${root}/attachments/${inherited.id}`, 'owner');
  assert.equal(served.status, 200);
  await served.arrayBuffer();

  const prompt = composeTaskPrompt(iteration, 'Witness [iter:2]\n\nFix the header.', files, '\n\n---\nPIPELINE');
  assert.ok(prompt.text.startsWith(`TASK_ID: ${iteration}\n\nWitness [iter:2]`));
  for (const f of files) {
    assert.ok(isAbsolute(f.path));
    assert.ok(prompt.text.includes(`\`${f.path}\``), f.name);
  }
  assert.match(prompt.text, /<attachments>[\s\S]*<\/attachments>[\s\S]*PIPELINE$/);
  const block = prompt.presentation.parts.find((p) => p.label === 'attachments');
  assert.deepEqual(block?.labelVars, { count: '2' });

  const plain = composeTaskPrompt(root, 'Brief', [], '');
  assert.doesNotMatch(plain.text, /attachments/);
});
