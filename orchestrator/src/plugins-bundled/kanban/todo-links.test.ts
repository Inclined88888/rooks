/** External references of a TO DO idea: `ctx.kanban.todos.links` and `todos.create(input, links)`. */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { dbApi } = await import('../../db.js');
const { todoApi, TodoLinkError } = await import('./todo-api.js');
const routes = await import('./project-todo-routes.js');

const { links } = todoApi;

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (err) { return err instanceof TodoLinkError ? err.code : 'other'; }
  return undefined;
}

test('set, list, findByRef and remove', () => {
  const todo = dbApi.insertProjectTodo({ text: 'linked' });
  const link = links.set(todo.id, {
    provider: 'github', ref: 'acme/app#12', url: 'https://github.com/acme/app/issues/12', label: 'Issue #12', pluginId: '@acme/gh',
  });
  assert.equal(link.provider, 'github');
  assert.equal(link.plugin_id, '@acme/gh');
  assert.deepEqual(links.list(todo.id).map((l) => l.ref), ['acme/app#12']);
  assert.equal(links.findByRef('github', 'acme/app#12')?.id, todo.id);
  assert.equal(links.findByRef('github', 'acme/app#13'), undefined);

  // Same idea, same ticket: url and label are refreshed, no second row.
  links.set(todo.id, { provider: 'github', ref: 'acme/app#12', url: 'https://github.com/acme/app/pull/12', label: 'PR' });
  const [only] = links.list(todo.id);
  assert.equal(links.list(todo.id).length, 1);
  assert.equal(only?.url, 'https://github.com/acme/app/pull/12');
  assert.equal(only?.label, 'PR');
  assert.equal(only?.plugin_id, '@acme/gh');

  assert.equal(links.remove(todo.id, 'github', 'acme/app#12'), true);
  assert.equal(links.remove(todo.id, 'github', 'acme/app#12'), false);
  assert.deepEqual(links.list(todo.id), []);
});

test('a ticket belongs to one idea: tying it to another is refused', () => {
  const a = dbApi.insertProjectTodo({ text: 'first' });
  const b = dbApi.insertProjectTodo({ text: 'second' });
  links.set(a.id, { provider: 'discord', ref: 'thread-1' });
  assert.equal(code(() => links.set(b.id, { provider: 'discord', ref: 'thread-1' })), 'conflict');
  assert.equal(links.findByRef('discord', 'thread-1')?.id, a.id);
  assert.deepEqual(links.list(b.id), []);
  // The same ref under another provider is another ticket.
  links.set(b.id, { provider: 'jira', ref: 'thread-1' });
  assert.equal(links.findByRef('jira', 'thread-1')?.id, b.id);
  assert.equal(code(() => links.set(999_999, { provider: 'jira', ref: 'X-1' })), 'not_found');
});

test('only http(s) URLs and well-formed links are accepted', () => {
  const todo = dbApi.insertProjectTodo({ text: 'urls' });
  for (const bad of [
    { provider: 'gh', ref: 'r1', url: 'javascript:alert(1)' },
    { provider: 'gh', ref: 'r2', url: 'data:text/html,<script>alert(1)</script>' },
    { provider: 'gh', ref: 'r3', url: 'ftp://example.com/x' },
    { provider: 'gh', ref: 'r4', url: 'not a url' },
    { provider: 'GitHub', ref: 'r5' },
    { provider: 'gh', ref: '   ' },
    { provider: 'gh', ref: 'r6', label: 'x'.repeat(201) },
  ]) {
    assert.equal(code(() => links.set(todo.id, bad)), 'invalid', JSON.stringify(bad));
    assert.equal(code(() => todoApi.create({ text: 'never' }, [bad])), 'invalid', JSON.stringify(bad));
  }
  assert.deepEqual(links.list(todo.id), []);
  assert.equal(dbApi.listProjectTodo({ limit: 1000 }).some((t) => t.text === 'never'), false);
});

test('deleting the idea deletes its links', () => {
  const todo = dbApi.insertProjectTodo({ text: 'gone' });
  links.set(todo.id, { provider: 'gh', ref: 'gone-1' });
  dbApi.deleteProjectTodo(todo.id);
  assert.equal(links.findByRef('gh', 'gone-1'), undefined);
  assert.deepEqual(links.list(todo.id), []);
});

test('create with links: the same ticket twice lands on the same idea', () => {
  const first = todoApi.create(
    { text: 'From Discord', author: 'ada', urgency: 'bug' },
    [{ provider: 'discord', ref: 'msg-42', url: 'https://discord.com/channels/1/2/42', label: 'Discord thread' }],
  );
  assert.equal(first.created, true);
  assert.equal(first.item.urgency, 'bug');
  assert.equal(links.list(first.item.id)[0]?.label, 'Discord thread');

  const again = todoApi.create({ text: 'From Discord, again' }, [
    { provider: 'github', ref: 'acme/app#77' },
    { provider: 'discord', ref: 'msg-42' },
  ]);
  assert.equal(again.created, false);
  assert.equal(again.item.id, first.item.id);
  // Nothing is written on a hit, not even the new link.
  assert.equal(links.findByRef('github', 'acme/app#77'), undefined);
  assert.equal(dbApi.listProjectTodo({ limit: 1000 }).some((t) => t.text === 'From Discord, again'), false);
});

test('create refuses links tied to two different ideas, and an empty text', () => {
  const a = todoApi.create({ text: 'a' }, [{ provider: 'gh', ref: 'two-a' }]).item;
  const b = todoApi.create({ text: 'b' }, [{ provider: 'gh', ref: 'two-b' }]).item;
  assert.notEqual(a.id, b.id);
  assert.equal(code(() => todoApi.create({ text: 'c' }, [{ provider: 'gh', ref: 'two-a' }, { provider: 'gh', ref: 'two-b' }])), 'conflict');
  assert.equal(code(() => todoApi.create({ text: '   ' })), 'invalid');
});

test('the routes return each idea with its links, and a PATCH cannot write them', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.auth = { kind: 'daemon-token', user: null, isSuperadmin: true }; next(); });
  routes.registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const { item } = todoApi.create({ text: 'routed', project: 'linkroutes' }, [
      { provider: 'gh', ref: 'route-1', url: 'https://example.com/1', label: 'One' },
    ]);
    const list = await (await fetch(`${base}/api/project-todo?project=linkroutes`)).json() as {
      items: Array<{ id: number; links: Array<{ ref: string; url: string | null }> }>;
    };
    assert.deepEqual(list.items.find((t) => t.id === item.id)?.links.map((l) => [l.ref, l.url]), [['route-1', 'https://example.com/1']]);

    // `links` is not a field a browser may write: the route now refuses it by name
    // (unknown field) instead of ignoring it, and nothing is stored.
    const refused = await fetch(`${base}/api/project-todo/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'routed, renamed', links: [{ provider: 'gh', ref: 'from-browser', url: 'https://evil.example' }] }),
    });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /links/);
    assert.equal(links.findByRef('gh', 'from-browser'), undefined);

    const patched = await (await fetch(`${base}/api/project-todo/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'routed, renamed' }),
    })).json() as { item: { text: string; links: Array<{ ref: string }> } };
    assert.equal(patched.item.text, 'routed, renamed');
    assert.deepEqual(patched.item.links.map((l) => l.ref), ['route-1']);

    const refusedPost = await fetch(`${base}/api/project-todo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'posted', links: [{ provider: 'gh', ref: 'posted-1' }] }),
    });
    assert.equal(refusedPost.status, 400);
    assert.equal(links.findByRef('gh', 'posted-1'), undefined);
  } finally { server.close(); }
});
