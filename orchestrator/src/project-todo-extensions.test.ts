/** A plugin attaching its own fields to the PATCH of a TO DO idea. */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { RequestAuth } from './users/identity.js';
import type { BusEvent } from './bus.js';

const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
const routes = await import('./plugins-bundled/kanban/project-todo-routes.js');
const { registerTodoExtension, TodoExtensionError } = await import('./project-todo-extensions.js');
const { todoApi } = await import('./plugins-bundled/kanban/todo-api.js');

const CLI: RequestAuth = { kind: 'daemon-token', user: null, isSuperadmin: true };

async function serve(): Promise<{ url: (p: string) => string; close: () => void }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.auth = CLI; next(); });
  routes.registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return { url: (p) => `http://127.0.0.1:${port}${p}`, close: () => server.close() };
}
const patch = (body: unknown): RequestInit => ({
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('an extension validates first, stores inside the write, and speaks before todo_done', async () => {
  const log: string[] = [];
  const stored = new Map<number, string>();
  const dispose = registerTodoExtension({
    id: 'test/stamp',
    fields: ['stamp'],
    prepare(_existing, body) {
      if (body.stamp === 'bad') throw new TodoExtensionError('bad stamp', 422);
      return {
        close: body.stamp === 'final',
        commit(updated) { stored.set(updated.id, String(body.stamp)); log.push('commit'); },
      };
    },
  });
  const on = (ev: BusEvent) => { if (ev.kind === 'todo_done') log.push('todo_done'); };
  bus.on('event', on);
  const d = await serve();
  try {
    const todo = dbApi.insertProjectTodo({ text: 'ext' });
    const url = d.url(`/api/project-todo/${todo.id}`);

    assert.equal((await fetch(url, patch({ stamp: 'bad', text: 'renamed' }))).status, 422);
    assert.equal(dbApi.getProjectTodo(todo.id)?.text, 'ext');
    assert.equal(stored.size, 0);

    assert.equal((await fetch(url, patch({ stamp: 'draft' }))).status, 200);
    assert.equal(stored.get(todo.id), 'draft');
    assert.equal(dbApi.getProjectTodo(todo.id)?.status, 'open');

    assert.equal((await fetch(url, patch({ stamp: 'final' }))).status, 200);
    assert.deepEqual(log, ['commit', 'commit', 'todo_done']);
    assert.equal(dbApi.getProjectTodo(todo.id)?.status, 'done');

    const other = dbApi.insertProjectTodo({ text: 'ext explicit' });
    await fetch(d.url(`/api/project-todo/${other.id}`), patch({ stamp: 'final', progress: 'to_test' }));
    assert.equal(dbApi.getProjectTodo(other.id)?.progress, 'to_test');
  } finally {
    bus.off('event', on);
    dispose();
    d.close();
  }
});

test('two extensions cannot own the same field', () => {
  const dispose = registerTodoExtension({ id: 'test/a', fields: ['shared'], prepare: () => null });
  try {
    assert.throws(() => registerTodoExtension({ id: 'test/b', fields: ['shared'], prepare: () => null }), /already owned/);
  } finally { dispose(); }
});

test('the TO DO API closes an idea, but never a promoted one', () => {
  const open = dbApi.insertProjectTodo({ text: 'api close' });
  assert.equal(todoApi.close(open.id)?.status, 'done');
  const promoted = dbApi.insertProjectTodo({ text: 'api promoted' });
  dbApi.markProjectTodoPromoted(promoted.id, 'task-x');
  assert.equal(todoApi.close(promoted.id)?.status, 'promoted');
  assert.equal(todoApi.update(open.id, { text: 'api edited' })?.text, 'api edited');
});
