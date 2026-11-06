/**
 * The TO DO connector contract, as a THIRD-PARTY plugin uses it through
 * `createPluginContext`: lifecycle events filtered by account and carrying
 * the origin of the write, edits through the PATCH path, and a durable,
 * ordered, signed outbox whose secrets never leave the vault.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-connector-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
process.env.TIMON_TODO_OUTCOME_ENABLED = '1';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError } = await import('./context.js');
const { createPluginOutbox, PluginOutboxError, PLUGIN_OUTBOX_PENDING_LIMIT } = await import('./outbox.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi, db } = await import('../db.js');
const { patchTodo, TodoLinkError } = await import('../plugins-bundled/kanban/todo-api.js');
const { registerTodoExtension } = await import('../project-todo-extensions.js');
const { outcomeExtension } = await import('../plugins-bundled/todo-outcomes/outcome.js');
const { ensureOutcomeTable } = await import('../plugins-bundled/todo-outcomes/store.js');
const { withTodoOrigin, todoOriginFromRequest } = await import('../todo-origin.js');
const { verifySignature } = await import('../triggers/signature.js');
const { invalidateSettingsCache } = await import('../settings.js');
ensureOutcomeTable();
registerTodoExtension(outcomeExtension);

const PLUGIN_ID = 'acme-connector';

function member(name: string, withPlugin: boolean) {
  const id = randomUUID();
  const user = createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'unused' });
  if (withPlugin) {
    grantTestPermissions(dbApi, id, [`plugin:${PLUGIN_ID}`]);
  }
  return user;
}
const ada = member('ada', true);
const bob = member('bob', true);
const carol = member('carol', false);

function identityOf(user: { id: string; email: string; name: string }) {
  return {
    viewer: { id: user.id, isSuperadmin: false, permissions: dbApi.listPermissionsForUser(user.id) },
    user: { id: user.id, email: user.email, name: user.name, is_superadmin: false },
    ownerUserId: user.id,
  };
}
const asAda = <T>(fn: () => Promise<T>) => runPluginRequest(identityOf(ada), fn);

const SECRETS: Record<string, string> = {
  'hook-key': 'whsec_c2VjcmV0LXNpZ25pbmcta2V5LXZhbHVlLTEyMzQ=',
  'api-token': 'ghp_TOPSECRETtokenValue0001',
  'hook-url': 'https://hooks.example.test/api/webhooks/42/SECRETPATHTOKEN',
};

type Call = { url: string; init: RequestInit };

async function pluginWith(permissions: string[], fetchImpl?: (call: Call) => Promise<Response>) {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ timon: { id: PLUGIN_ID, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const calls: Call[] = [];
  let clock = 1_000_000;
  const outbox = createPluginOutbox({
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const call = { url: String(input), init: init ?? {} };
      calls.push(call);
      return fetchImpl ? fetchImpl(call) : new Response('ok');
    }) as typeof fetch,
    secret: (_plugin, name) => SECRETS[name],
    allow: (_plugin, url) => { if (!/^https:\/\/[a-z.]*example\.test\//.test(url)) throw new Error(`host of ${url} refused`); },
    now: () => clock,
    schedule: false,
  });
  const host = { ...daemonHost(root), outbox };
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, host);
  return {
    plugin, outbox, calls,
    advance: (ms: number) => { clock += ms; },
    dispose: () => root.fiber.dispose(),
  };
}

/** Events are delivered deferred; wait until the condition holds. */
async function until(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}
const settle = () => new Promise((r) => setTimeout(r, 30));

const idea = (text: string, owner: string | null) => dbApi.insertProjectTodo({ text, ownerUserId: owner });
const closeAs = (origin: { kind: 'user' | 'agent' | 'plugin' | 'system'; id: string | null }, id: number) =>
  withTodoOrigin(origin, () => patchTodo(dbApi.getProjectTodo(id)!, { progress: 'done' }, {}));

test('each capability is refused without its permission', async () => {
  const bare = await pluginWith(['todos:read']);
  assert.throws(() => bare.plugin.events.on('todo_done', () => undefined), PluginPermissionError);
  await assert.rejects(bare.plugin.kanban.todos.update(1, { text: 'x' }), PluginPermissionError);
  await assert.rejects(bare.plugin.kanban.todos.close(1), PluginPermissionError);
  await assert.rejects(bare.plugin.outbox.post('https://hooks.example.test/a', {}), PluginPermissionError);
  await bare.dispose();

  // Events without `todos:read`: the event carries the idea.
  const listener = await pluginWith(['events:subscribe']);
  assert.throws(() => listener.plugin.events.on('todo_resolved', () => undefined), PluginPermissionError);
  assert.doesNotThrow(() => listener.plugin.events.on('task_done', () => undefined));
  await listener.dispose();

  // Naming a vault entry needs `secrets:read`.
  const sender = await pluginWith(['http:outbound']);
  await assert.rejects(sender.plugin.outbox.post({ secret: 'hook-url' }, {}), PluginPermissionError);
  await assert.rejects(sender.plugin.outbox.post('https://hooks.example.test/a', {}, { sign: { secret: 'hook-key' } }), PluginPermissionError);
  assert.equal(sender.calls.length, 0);
  await sender.dispose();
});

test('a TO DO event reaches the plugin only for an idea its reads would see, inside that account', async () => {
  const { plugin, dispose } = await pluginWith(['events:subscribe', 'todos:read']);
  const seen: Array<{ id: number; user: string | undefined; sawAda: boolean }> = [];
  const adaIdea = idea('Ada idea', ada.id);
  plugin.events.on('todo_done', async (ev) => {
    // The handler reads as the idea's account: Bob's handler never sees Ada's idea.
    const sawAda = (await plugin.kanban.todos.get(adaIdea.id)) !== undefined;
    seen.push({ id: ev.todoId, user: plugin.user()?.id, sawAda });
  });

  const bobIdea = idea('Bob idea', bob.id);
  const carolIdea = idea('Carol idea (plugin not allowed)', carol.id);
  const systemIdea = idea('System idea', null);
  const otherPluginIdea = idea('Other plugin idea', 'plugin:someone-else');
  const ownIdea = idea('Own idea', `plugin:${PLUGIN_ID}`);
  for (const t of [adaIdea, bobIdea, carolIdea, systemIdea, otherPluginIdea, ownIdea]) closeAs({ kind: 'system', id: null }, t.id);

  await until(() => seen.length >= 3, 'three deliveries');
  await settle();
  assert.deepEqual(seen.map((s) => s.id).sort(), [adaIdea.id, bobIdea.id, ownIdea.id].sort());
  assert.deepEqual(seen.find((s) => s.id === adaIdea.id), { id: adaIdea.id, user: ada.id, sawAda: true });
  assert.deepEqual(seen.find((s) => s.id === bobIdea.id), { id: bobIdea.id, user: bob.id, sawAda: false });
  assert.deepEqual(seen.find((s) => s.id === ownIdea.id), { id: ownIdea.id, user: undefined, sawAda: false });
  await dispose();
});

test('the origin names the writer: a facade write is the plugin, a cockpit write the user', async () => {
  const { plugin, dispose } = await pluginWith(['events:subscribe', 'todos:read', 'todos:write']);
  const origins = new Map<number, unknown>();
  plugin.events.on('todo_done', (ev) => { origins.set(ev.todoId, ev.origin); });

  const viaPlugin = idea('closed by the connector', ada.id);
  const closed = await asAda(() => plugin.kanban.todos.close(viaPlugin.id));
  assert.equal(closed.progress, 'done');
  const viaUser = idea('closed in the cockpit', ada.id);
  closeAs({ kind: 'user', id: ada.id }, viaUser.id);
  const viaChain = idea('closed by its chain', ada.id);
  dbApi.updateProjectTodo(viaChain.id, { status: 'done', progress: 'done' });

  await until(() => origins.size === 3, 'three origins');
  assert.deepEqual(origins.get(viaPlugin.id), { kind: 'plugin', id: PLUGIN_ID });
  assert.deepEqual(origins.get(viaUser.id), { kind: 'user', id: ada.id });
  assert.deepEqual(origins.get(viaChain.id), { kind: 'system', id: null });
  await dispose();
});

test('an HTTP write is attributed from what the auth middleware established, not from a header alone', () => {
  const req = (auth: unknown, agent?: string) => ({
    auth, header: (name: string) => (name === 'X-TIMON-Agent' ? agent : undefined),
  }) as unknown as Request;
  const userRow = dbApi.getUserById(ada.id);
  assert.deepEqual(todoOriginFromRequest(req({ kind: 'session', user: userRow, isSuperadmin: false }, 'forged')), { kind: 'user', id: ada.id });
  assert.deepEqual(todoOriginFromRequest(req({ kind: 'daemon-token', user: null, isSuperadmin: true }, 'proj.coder')), { kind: 'agent', id: 'proj.coder' });
  assert.deepEqual(todoOriginFromRequest(req({ kind: 'api-token', user: null, isSuperadmin: false, actorId: `plugin:${PLUGIN_ID}` })), { kind: 'plugin', id: PLUGIN_ID });
  assert.deepEqual(todoOriginFromRequest(req(undefined, 'forged')), { kind: 'system', id: null });
});

test('todo_deleted carries the idea and its links as they stood before the delete', async () => {
  const { plugin, dispose } = await pluginWith(['events:subscribe', 'todos:read', 'todos:write']);
  const deleted: unknown[] = [];
  plugin.events.on('todo_deleted', (ev) => { deleted.push(ev); });
  const { item } = await asAda(() => plugin.kanban.todos.create(
    { text: 'Ticket mirrored', project: 'acme', notes: 'private notes' },
    [{ provider: 'github', ref: 'acme/app#7', url: 'https://github.com/acme/app/issues/7' }],
  ));
  withTodoOrigin({ kind: 'user', id: ada.id }, () => dbApi.deleteProjectTodo(item.id));
  assert.deepEqual(dbApi.listTodoExternalRefs([item.id]), [], 'the cascade removed the links');

  await until(() => deleted.length === 1, 'the deletion');
  const ev = deleted[0] as { kind: string; todoId: number; origin: unknown; todo: Record<string, unknown> & { links: Array<Record<string, unknown>> } };
  assert.equal(ev.kind, 'todo_deleted');
  assert.equal(ev.todoId, item.id);
  assert.deepEqual(ev.origin, { kind: 'user', id: ada.id });
  assert.deepEqual(Object.keys(ev.todo).sort(), ['id', 'links', 'owner_user_id', 'project', 'text']);
  assert.equal(ev.todo.owner_user_id, ada.id);
  assert.deepEqual(ev.todo.links.map((l) => [l.provider, l.ref, l.plugin_id]), [['github', 'acme/app#7', PLUGIN_ID]]);
  assert.ok(Object.isFrozen(ev) && Object.isFrozen(ev.todo));
  await dispose();
});

test('a deletion made through ctx.kanban.todos.delete carries this plugin as its origin', async () => {
  const { plugin, dispose } = await pluginWith(['events:subscribe', 'todos:read', 'todos:write']);
  const deleted: Array<{ todoId: number; origin: unknown }> = [];
  plugin.events.on('todo_deleted', (ev) => { deleted.push(ev); });
  const { item } = await asAda(() => plugin.kanban.todos.create({ text: 'Mirrored then removed' }));
  await asAda(() => plugin.kanban.todos.delete(item.id));

  await until(() => deleted.length === 1, 'the deletion');
  assert.equal(deleted[0]?.todoId, item.id);
  assert.deepEqual(deleted[0]?.origin, { kind: 'plugin', id: PLUGIN_ID }, 'a connector drops its own echo by this origin');
  await dispose();
});

test('an edit goes through the PATCH path: outcome rules, refusal when outcomes are off, unknown keys refused', async () => {
  const { plugin, dispose } = await pluginWith(['todos:read', 'todos:write']);
  const t = idea('TIM-0950 · edit', ada.id);
  const codeOf = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (err) { return err instanceof TodoLinkError ? err.code : String(err); }
    return undefined;
  };
  const edited = await asAda(() => plugin.kanban.todos.update(t.id, { text: '  TIM-0950 · edited ', urgency: 'bug' }));
  assert.equal(edited.text, 'TIM-0950 · edited');
  assert.equal(edited.urgency, 'bug');
  assert.equal(await codeOf(() => asAda(() => plugin.kanban.todos.update(t.id, { colour: 'red' }))), 'invalid');
  assert.equal(await codeOf(() => asAda(() => plugin.kanban.todos.update(t.id, { status: 'promoted' as 'open' }))), 'invalid');
  assert.equal(await codeOf(() => asAda(() => plugin.kanban.todos.update(t.id, { resolution: 'duplicate', duplicate_of: 'nope' }))), 'invalid');
  // Bob cannot edit Ada's idea; it answers as a missing one.
  assert.equal(await codeOf(() => runPluginRequest(identityOf(bob), () => plugin.kanban.todos.update(t.id, { text: 'hijack' }))), 'not_found');

  process.env.TIMON_TODO_OUTCOME_ENABLED = '0';
  invalidateSettingsCache();
  try {
    assert.equal(await codeOf(() => asAda(() => plugin.kanban.todos.update(t.id, { resolution: 'fixed' }))), 'forbidden');
  } finally {
    process.env.TIMON_TODO_OUTCOME_ENABLED = '1';
    invalidateSettingsCache();
  }
  assert.equal(dbApi.getProjectTodo(t.id)?.progress, 'todo', 'a refused edit writes nothing');
  const fixed = await asAda(() => plugin.kanban.todos.update(t.id, { resolution: 'fixed', public_note: 'Shipped.' }));
  assert.equal(fixed.progress, 'done', 'a settling outcome closes the idea, as through the route');
  await dispose();
});

test('todo_resolved then todo_done are handled in order, and their calls leave in that order, retried after a failure', async () => {
  let failNext = true;
  const { plugin, outbox, calls, advance, dispose } = await pluginWith(
    ['events:subscribe', 'todos:read', 'todos:write', 'http:outbound', 'secrets:read'],
    async () => {
      if (failNext) { failNext = false; return new Response('busy', { status: 503 }); }
      return new Response('ok');
    },
  );
  const url = 'https://hooks.example.test/timon';
  const handled: string[] = [];
  plugin.events.on('todo_resolved', async (ev) => {
    if (ev.origin.kind === 'plugin' && ev.origin.id === plugin.id) return; // never in this test: the user writes
    // A slow handler: the closure that follows still waits for it.
    await new Promise((r) => setTimeout(r, 20));
    handled.push('resolved');
    await plugin.outbox.post(url, { event: 'resolved', id: ev.todoId }, { key: `todo:${ev.todoId}`, sign: { secret: 'hook-key' } });
  });
  plugin.events.on('todo_done', async (ev) => {
    handled.push('done');
    await plugin.outbox.post(url, { event: 'done', id: ev.todoId }, { key: `todo:${ev.todoId}`, sign: { secret: 'hook-key' } });
  });

  const t = idea('TIM-0951 · ordered', ada.id);
  withTodoOrigin({ kind: 'user', id: ada.id }, () => patchTodo(dbApi.getProjectTodo(t.id)!, {}, { resolution: 'fixed' }));
  await until(() => handled.length === 2, 'both handlers');
  assert.deepEqual(handled, ['resolved', 'done']);

  // First attempt of the outcome fails: the closure waits behind it.
  assert.equal(await outbox.deliverDue(), 0);
  assert.equal(calls.length, 1);
  assert.equal(await outbox.deliverDue(), 0, 'nothing is due before the back-off');
  assert.equal(calls.length, 1, 'the closure does not overtake the failed outcome');

  advance(61_000);
  assert.equal(await outbox.deliverDue(), 2);
  const bodies = calls.map((c) => JSON.parse(String(c.init.body)) as { event: string });
  assert.deepEqual(bodies.map((b) => b.event), ['resolved', 'resolved', 'done']);

  // Standard Webhooks: same id across attempts, a signature the receiver verifies.
  const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name]!;
  assert.equal(header(calls[0]!, 'webhook-id'), header(calls[1]!, 'webhook-id'));
  assert.notEqual(header(calls[1]!, 'webhook-id'), header(calls[2]!, 'webhook-id'));
  for (const c of calls) {
    const headers = Object.fromEntries(Object.entries(c.init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const verdict = verifySignature('standard', SECRETS['hook-key']!, Buffer.from(String(c.init.body)), headers, 1_061_000);
    assert.equal(verdict.ok, true);
  }
  const [first] = db.prepare(`SELECT id FROM plugin_outbox WHERE plugin_id = ? ORDER BY seq LIMIT 1`).all(PLUGIN_ID) as Array<{ id: string }>;
  const entry = await plugin.outbox.get(first!.id);
  assert.equal(entry?.state, 'delivered');
  assert.equal(entry?.attempts, 2);
  await dispose();
});

test('a secret never reaches the queue, an error, a log or the journal', async () => {
  const logged: string[] = [];
  const spies = (['log', 'warn', 'error'] as const).map((level) => {
    const original = console[level];
    console[level] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    return () => { console[level] = original; };
  });
  try {
    const { plugin, outbox, calls, dispose } = await pluginWith(['http:outbound', 'secrets:read'], async (call) => {
      if (call.url.includes('throw')) throw new Error(`boom ${SECRETS['api-token']}`);
      return new Response(`denied ${SECRETS['api-token']}`, { status: 401 });
    });
    const viaSecretUrl = await plugin.outbox.post({ secret: 'hook-url' }, { n: 1 }, { auth: { secret: 'api-token' } });
    const thrown = await plugin.outbox.post('https://hooks.example.test/throw', { n: 2 }, { auth: { secret: 'api-token', header: 'X-Api-Key', scheme: '' }, sign: { secret: 'hook-key' } });
    await outbox.deliverDue();

    // The calls carried the credentials…
    assert.equal(calls[0]!.url, SECRETS['hook-url']);
    assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, `Bearer ${SECRETS['api-token']}`);
    assert.equal((calls[1]!.init.headers as Record<string, string>)['x-api-key'], SECRETS['api-token']);
    // …the queue, its errors and the logs did not.
    const rows = JSON.stringify(db.prepare(`SELECT * FROM plugin_outbox WHERE plugin_id = ?`).all(PLUGIN_ID));
    for (const value of Object.values(SECRETS)) {
      assert.ok(!rows.includes(value), 'no secret in plugin_outbox');
      assert.ok(!logged.join('\n').includes(value), 'no secret in a log');
    }
    assert.ok(!rows.includes('SECRETPATHTOKEN'));
    const refused = await plugin.outbox.get(viaSecretUrl.id);
    assert.deepEqual([refused?.state, refused?.last_error, refused?.attempts], ['failed', 'HTTP 401', 1], 'a 401 is final');
    const retried = await plugin.outbox.get(thrown.id);
    assert.deepEqual([retried?.state, retried?.last_error], ['pending', 'Error']);

    // Refusals at post name the entry, never its value.
    const errors: string[] = [];
    for (const attempt of [
      () => plugin.outbox.post({ secret: 'missing' }, {}),
      () => plugin.outbox.post('https://elsewhere.invalid/x', {}),
      () => plugin.outbox.post('https://hooks.example.test/x', {}, { headers: { Authorization: SECRETS['api-token']! } }),
    ]) {
      try { await attempt(); assert.fail('expected a refusal'); } catch (err) {
        assert.ok(err instanceof PluginOutboxError);
        errors.push(err.message);
      }
    }
    assert.ok(!errors.join('\n').includes(SECRETS['api-token']!));
    await dispose();
  } finally {
    for (const restore of spies) restore();
  }
});

test('the outbox refuses an unserialisable or oversized body, and a method it does not send', async () => {
  const { plugin, dispose } = await pluginWith(['http:outbound']);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await assert.rejects(plugin.outbox.post('https://hooks.example.test/x', cyclic), (err: unknown) => err instanceof PluginOutboxError && err.code === 'invalid');
  await assert.rejects(plugin.outbox.post('https://hooks.example.test/x', 'x'.repeat(300 * 1024)), (err: unknown) => err instanceof PluginOutboxError && err.code === 'invalid');
  await assert.rejects(plugin.outbox.post('https://hooks.example.test/x', {}, { method: 'GET' as 'POST' }), (err: unknown) => err instanceof PluginOutboxError && err.code === 'invalid');
  await dispose();
});

test('a plugin whose receiver is dead stops at PLUGIN_OUTBOX_PENDING_LIMIT calls, and only that plugin', async () => {
  const { plugin, outbox, dispose } = await pluginWith(['http:outbound']);
  const other = `${PLUGIN_ID}-neighbour`;
  const url = 'https://hooks.example.test/full';
  const clear = () => db.prepare(`DELETE FROM plugin_outbox WHERE plugin_id IN (?, ?)`).run(PLUGIN_ID, other);
  clear();
  try {
    for (let i = 0; i < PLUGIN_OUTBOX_PENDING_LIMIT; i++) outbox.enqueue(PLUGIN_ID, url, { i }, {});
    const full = (err: unknown) => err instanceof PluginOutboxError && err.code === 'full';
    await assert.rejects(plugin.outbox.post(url, { i: 'one too many' }), full);
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM plugin_outbox WHERE plugin_id = ?`).get(PLUGIN_ID) as { n: number }).n,
      PLUGIN_OUTBOX_PENDING_LIMIT, 'the refused call left no row');
    assert.match(outbox.enqueue(other, url, {}, {}), /^msg_/, 'another plugin\'s queue is its own');
    // A delivered and a failed call no longer wait: they free their places.
    const [a, b] = db.prepare(`SELECT id FROM plugin_outbox WHERE plugin_id = ? ORDER BY seq LIMIT 2`).all(PLUGIN_ID) as Array<{ id: string }>;
    db.prepare(`UPDATE plugin_outbox SET delivered_at = 1 WHERE id = ?`).run(a!.id);
    db.prepare(`UPDATE plugin_outbox SET failed_at = 1 WHERE id = ?`).run(b!.id);
    await plugin.outbox.post(url, { i: 'after a delivery' });
    await plugin.outbox.post(url, { i: 'after a failure' });
    await assert.rejects(plugin.outbox.post(url, { i: 'full again' }), full);
  } finally {
    clear();
    await dispose();
  }
});
