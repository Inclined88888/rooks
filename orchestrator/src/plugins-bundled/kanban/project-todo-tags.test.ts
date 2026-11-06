/** Tags of the TO DO notebook: closed vocabulary, filters, status/progress sync. */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const routes = await import('./project-todo-routes.js');

async function serve(): Promise<{ url: (p: string) => string; close: () => void }> {
  const app = express();
  app.use(express.json());
  // The PATCH route requires an authenticated caller: act as the CLI does.
  app.use((req, _res, next) => { req.auth = { kind: 'daemon-token', user: null, isSuperadmin: true }; next(); });
  routes.registerRoutes(app);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return { url: (p) => `http://127.0.0.1:${port}${p}`, close: () => server.close() };
}
const json = (body: unknown): RequestInit => ({
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const patch = (body: unknown): RequestInit => ({ ...json(body), method: 'PATCH' });

test('a new idea is untagged on urgency and starts at progress todo', async () => {
  const d = await serve();
  try {
    const { item } = await (await fetch(d.url('/api/project-todo'), json({ text: 'plain' }))).json();
    assert.equal(item.urgency, null);
    assert.equal(item.progress, 'todo');
  } finally { d.close(); }
});

test('tags outside the closed vocabulary are refused', async () => {
  const d = await serve();
  try {
    assert.equal((await fetch(d.url('/api/project-todo'), json({ text: 'x', urgency: 'urgent!!' }))).status, 400);
    assert.equal((await fetch(d.url('/api/project-todo'), json({ text: 'x', progress: 'wip' }))).status, 400);
    const { item } = await (await fetch(d.url('/api/project-todo'), json({ text: 'ok', urgency: 'bug' }))).json();
    assert.equal((await fetch(d.url(`/api/project-todo/${item.id}`), patch({ urgency: 'nope' }))).status, 400);
    assert.equal((await fetch(d.url(`/api/project-todo/${item.id}`), patch({ progress: 'nope' }))).status, 400);
    assert.equal((await fetch(d.url('/api/project-todo?urgency=nope'))).status, 400);
    assert.equal((await fetch(d.url('/api/project-todo?progress=nope'))).status, 400);
  } finally { d.close(); }
});

test('urgency can be set, changed and cleared', async () => {
  const d = await serve();
  try {
    const { item } = await (await fetch(d.url('/api/project-todo'), json({ text: 'u', urgency: 'idea' }))).json();
    assert.equal(item.urgency, 'idea');
    const up = await (await fetch(d.url(`/api/project-todo/${item.id}`), patch({ urgency: 'critical' }))).json();
    assert.equal(up.item.urgency, 'critical');
    const cleared = await (await fetch(d.url(`/api/project-todo/${item.id}`), patch({ urgency: null }))).json();
    assert.equal(cleared.item.urgency, null);
  } finally { d.close(); }
});

test('progress done checks the idea, and leaving done unchecks it', async () => {
  const d = await serve();
  try {
    const { item } = await (await fetch(d.url('/api/project-todo'), json({ text: 'sync' }))).json();
    const done = await (await fetch(d.url(`/api/project-todo/${item.id}`), patch({ progress: 'done' }))).json();
    assert.equal(done.item.status, 'done');
    assert.notEqual(done.item.done_at, null);
    const back = await (await fetch(d.url(`/api/project-todo/${item.id}`), patch({ progress: 'to_test' }))).json();
    assert.equal(back.item.status, 'open');
    assert.equal(back.item.done_at, null);
  } finally { d.close(); }
});

test('checking the box sets progress done, unchecking resets it to todo', async () => {
  const d = await serve();
  try {
    const { item } = await (await fetch(d.url('/api/project-todo'), json({ text: 'box', progress: 'analyzed' }))).json();
    const done = await (await fetch(d.url(`/api/project-todo/${item.id}`), patch({ status: 'done' }))).json();
    assert.equal(done.item.progress, 'done');
    const open = await (await fetch(d.url(`/api/project-todo/${item.id}`), patch({ status: 'open' }))).json();
    assert.equal(open.item.progress, 'todo');
    // Unchecking something tagged otherwise keeps its tag.
    const mid = await (await fetch(d.url('/api/project-todo'), json({ text: 'keep', progress: 'partial' }))).json();
    const still = await (await fetch(d.url(`/api/project-todo/${mid.item.id}`), patch({ status: 'open' }))).json();
    assert.equal(still.item.progress, 'partial');
  } finally { d.close(); }
});

test('list filters by urgency and progress', async () => {
  const d = await serve();
  try {
    const a = await (await fetch(d.url('/api/project-todo'), json({ text: 'f-a', project: 'tagfilter', urgency: 'bug', progress: 'to_test' }))).json();
    await fetch(d.url('/api/project-todo'), json({ text: 'f-b', project: 'tagfilter', urgency: 'idea' }));
    const byUrgency = await (await fetch(d.url('/api/project-todo?project=tagfilter&urgency=bug'))).json();
    assert.deepEqual(byUrgency.items.map((i: { id: number }) => i.id), [a.item.id]);
    const byProgress = await (await fetch(d.url('/api/project-todo?project=tagfilter&progress=to_test'))).json();
    assert.deepEqual(byProgress.items.map((i: { id: number }) => i.id), [a.item.id]);
    const todo = await (await fetch(d.url('/api/project-todo?project=tagfilter&progress=todo'))).json();
    assert.equal(todo.items.length, 1);
    assert.equal(todo.items[0].text, 'f-b');
  } finally { d.close(); }
});
