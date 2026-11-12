/** Outcome of a TO DO idea: closed vocabulary, public note, duplicate reference. */
import '../../test-home.js';
// The outcome is opt-in; these tests exercise the enabled path unless they say otherwise.
process.env.ROOKS_TODO_OUTCOME_ENABLED = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { RequestAuth } from '../../users/identity.js';

const { dbApi } = await import('../../db.js');
const kanbanRoutes = await import('../kanban/project-todo-routes.js');
const routes = await import('./routes.js');
const { patchTodo } = await import('../kanban/todo-api.js');
const { registerTodoExtension, TodoExtensionError } = await import('../../project-todo-extensions.js');
const { outcomeExtension } = await import('./outcome.js');
const { ensureOutcomeTable, getOutcome } = await import('./store.js');
const { invalidateSettingsCache } = await import('../../settings.js');
ensureOutcomeTable();
registerTodoExtension(outcomeExtension);

const write = (id: number, body: Record<string, unknown>) => patchTodo(dbApi.getProjectTodo(id)!, {}, body);

test('a new idea has no outcome', () => {
  const todo = dbApi.insertProjectTodo({ text: 'TIM-0100 · fresh' });
  assert.deepEqual(getOutcome(todo.id), { resolution: null, public_note: null, duplicate_of: null });
});

test('public note and duplicate reference are stored, and null clears them', () => {
  const todo = dbApi.insertProjectTodo({ text: 'SUG-0010 · dup' });
  write(todo.id, { resolution: 'duplicate', duplicate_of: 'SUG-0007', public_note: '  Tracked in SUG-0007.  ' });
  assert.deepEqual(getOutcome(todo.id), { resolution: 'duplicate', duplicate_of: 'SUG-0007', public_note: 'Tracked in SUG-0007.' });
  write(todo.id, { duplicate_of: null, public_note: null });
  assert.deepEqual(getOutcome(todo.id), { resolution: 'duplicate', duplicate_of: null, public_note: null });
});

test('invalid outcome fields are refused and nothing is written', () => {
  const todo = dbApi.insertProjectTodo({ text: 'TIM-0104 · invalid' });
  for (const bad of [
    { resolution: 'wontfix' },
    { public_note: 'x'.repeat(501) },
    { public_note: 42 },
    { resolution: 'duplicate', duplicate_of: 'TIM-12' },
    { resolution: 'duplicate', duplicate_of: 'BUG-0001' },
    { resolution: 'duplicate', duplicate_of: 'TIM-0001 ' },
    { resolution: 'fixed', duplicate_of: 'TIM-0001' },
    { duplicate_of: 'TIM-0001' },
  ]) {
    assert.throws(() => write(todo.id, { ...bad, text: 'renamed' }), TodoExtensionError, JSON.stringify(bad));
  }
  assert.equal(getOutcome(todo.id).resolution, null);
  assert.equal(dbApi.getProjectTodo(todo.id)?.status, 'open');
  write(todo.id, { public_note: 'x'.repeat(500) });
  assert.equal(getOutcome(todo.id).public_note?.length, 500);
});

test('deleting the idea deletes its outcome', () => {
  const todo = dbApi.insertProjectTodo({ text: 'TIM-0109 · deleted' });
  write(todo.id, { resolution: 'planned' });
  dbApi.deleteProjectTodo(todo.id);
  assert.equal(getOutcome(todo.id).resolution, null);
});

async function serve(auth: RequestAuth | null): Promise<{ url: (p: string) => string; close: () => void }> {
  const app = express();
  app.use(express.json());
  if (auth) app.use((req, _res, next) => { req.auth = auth; next(); });
  kanbanRoutes.registerRoutes(app);
  routes.registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return { url: (p) => `http://127.0.0.1:${port}${p}`, close: () => server.close() };
}
const patch = (body: unknown): RequestInit => ({
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const CLI: RequestAuth = { kind: 'daemon-token', user: null, isSuperadmin: true };

test('an anonymous caller can neither set nor read an outcome', async () => {
  const todo = dbApi.insertProjectTodo({ text: 'TIM-0110 · anon' });
  const d = await serve(null);
  try {
    assert.equal((await fetch(d.url(`/api/project-todo/${todo.id}`), patch({ resolution: 'declined' }))).status, 401);
    assert.equal((await fetch(d.url(`/api/todo-outcomes/outcome/${todo.id}`))).status, 401);
    assert.equal((await fetch(d.url('/api/todo-outcomes/config'))).status, 401);
    assert.equal(getOutcome(todo.id).resolution, null);
  } finally { d.close(); }
});

test('the PATCH writes the outcome, the plugin route reads it, and bad values get a 400', async () => {
  const d = await serve(CLI);
  try {
    const todo = dbApi.insertProjectTodo({ text: 'SUG-0111 · route' });
    const url = d.url(`/api/project-todo/${todo.id}`);
    for (const bad of [
      { resolution: 'wontfix' },
      { public_note: 'x'.repeat(501) },
      { public_note: 42 },
      { resolution: 'duplicate', duplicate_of: 'SUG-12' },
      { resolution: 'fixed', duplicate_of: 'SUG-0001' },
    ]) {
      assert.equal((await fetch(url, patch(bad))).status, 400, JSON.stringify(bad));
    }
    const ok = await (await fetch(url, patch({ resolution: 'duplicate', duplicate_of: 'SUG-0001', public_note: 'See SUG-0001.' }))).json() as {
      item: { status: string };
    };
    assert.equal(ok.item.status, 'done');
    const read = await (await fetch(d.url(`/api/todo-outcomes/outcome/${todo.id}`))).json() as { outcome: unknown };
    assert.deepEqual(read.outcome, { resolution: 'duplicate', duplicate_of: 'SUG-0001', public_note: 'See SUG-0001.' });
    assert.equal((await fetch(d.url('/api/todo-outcomes/outcome/999999'))).status, 404);
    assert.deepEqual(await (await fetch(d.url('/api/todo-outcomes/config'))).json(), { enabled: true });
  } finally { d.close(); }
});

test('the PATCH refuses the outcome fields while the feature is disabled', async () => {
  const d = await serve(CLI);
  process.env.ROOKS_TODO_OUTCOME_ENABLED = '0';
  invalidateSettingsCache();
  try {
    const todo = dbApi.insertProjectTodo({ text: 'SUG-0112 · disabled' });
    const url = d.url(`/api/project-todo/${todo.id}`);
    assert.equal((await fetch(url, patch({ resolution: 'fixed' }))).status, 403);
    assert.equal((await fetch(url, patch({ public_note: 'x', notes: 'with core' }))).status, 403);
    assert.equal(dbApi.getProjectTodo(todo.id)?.notes, null);
    assert.equal((await fetch(url, patch({ notes: 'plain edit' }))).status, 200);
    assert.equal(getOutcome(todo.id).resolution, null);
    assert.deepEqual(await (await fetch(d.url('/api/todo-outcomes/config'))).json(), { enabled: false });
  } finally {
    process.env.ROOKS_TODO_OUTCOME_ENABLED = '1';
    invalidateSettingsCache();
    d.close();
  }
});
