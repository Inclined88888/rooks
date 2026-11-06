/**
 * `ctx.notifications` as a third-party plugin reaches it (API 10): bounded by
 * the owner column like the centre's own routes, read and write apart, and
 * `notifications:read:all` is what widens a request, never the plugin.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-notifications-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError } = await import('./context.js');
const { PluginNotificationError } = await import('./notifications-facade.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { bus } = await import('../bus.js');
const { createNotification } = await import('../notifications.js');
const { setActiveModules, resetActiveModules } = await import('../kernel/module-state.js');

const A = 'plugin-a';

function member(name: string, permissions: string[] = []) {
  const id = randomUUID();
  const user = createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'unused' });
  grantTestPermissions(dbApi, id, [`plugin:${A}`, ...permissions]);
  return user;
}
const ada = member('ada');
const bob = member('bob');
const admin = member('admin', ['notifications:read:all']);
dbApi.createMission('m-ada', 'timon.coder', 'work', undefined, ada.id);

const identityOf = (user: { id: string; email: string; name: string }) => ({
  viewer: { id: user.id, isSuperadmin: false, permissions: dbApi.listPermissionsForUser(user.id) },
  user: { id: user.id, email: user.email, name: user.name, is_superadmin: false },
  ownerUserId: user.id,
});
const as = <T>(user: { id: string; email: string; name: string }, fn: () => Promise<T>) => runPluginRequest(identityOf(user), fn);

async function pluginWith(permissions: string[]) {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ timon: { id: A, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(root));
  return { plugin, dispose: () => root.fiber.dispose() };
}

const raise = (owner: string | null, title: string, type: 'alert' | 'report' | 'action_required' = 'alert', extra: { missionId?: string; anchor?: string; source?: string } = {}) => {
  const row = createNotification({ type, title, ownerUserId: owner, ...extra });
  assert.ok(row);
  return row;
};

test('a missing permission is refused: read and write are apart', async () => {
  const n = raise(ada.id, 'mine');
  const reader = await pluginWith(['notifications:read']);
  await assert.rejects(as(ada, () => reader.plugin.notifications.dismiss(n.id)), PluginPermissionError);
  const writer = await pluginWith(['notifications:write']);
  await assert.rejects(as(ada, () => writer.plugin.notifications.list()), PluginPermissionError);
  const nothing = await pluginWith(['notify']);
  await assert.rejects(as(ada, () => nothing.plugin.notifications.list()), PluginPermissionError);
  assert.equal(dbApi.getNotification(n.id)?.dismissed_at, null, 'nothing was dismissed');
  await reader.dispose(); await writer.dispose(); await nothing.dispose();
});

test('a request sees its own notifications; a job only those of its plugin', async () => {
  const mine = raise(ada.id, 'ada-1', 'action_required', { missionId: 'm-ada', anchor: 'card-1' });
  const bobs = raise(bob.id, 'bob-1');
  const system = raise(null, 'system-1');
  const pluginOwn = raise(`plugin:${A}`, 'plugin-1', 'report', { source: `plugin:${A}` });
  const { plugin, dispose } = await pluginWith(['notifications:read', 'notifications:write']);
  const ids = async (user: typeof ada) => (await as(user, () => plugin.notifications.list())).map((n) => n.id);
  const adas = await as(ada, () => plugin.notifications.list());
  assert.ok(adas.every((n) => [mine.id].includes(n.id) || dbApi.getNotification(n.id)?.owner_user_id === ada.id), 'only Ada\'s rows');
  const first = adas.find((n) => n.id === mine.id)!;
  assert.equal(first.anchor, 'card-1');
  assert.equal(first.agent, 'timon.coder', 'the agent behind it, from its mission');
  assert.equal(first.urgent, false);
  for (const n of [bobs, system, pluginOwn]) assert.ok(!adas.some((x) => x.id === n.id), `Ada does not see ${n.title}`);
  const bobsView = await ids(bob);
  assert.ok(bobsView.includes(bobs.id) && !bobsView.includes(mine.id));
  const job = (await plugin.notifications.list()).map((n) => n.id);
  assert.ok(job.includes(pluginOwn.id), 'a job: its plugin\'s own');
  for (const n of [mine, bobs, system]) assert.ok(!job.includes(n.id), `a job does not see ${n.title}`);
  const wide = (await as(admin, () => plugin.notifications.list())).map((n) => n.id);
  for (const n of [mine, bobs, system, pluginOwn]) assert.ok(wide.includes(n.id), `notifications:read:all sees ${n.title}`);
  // Another account's notification answers as one that does not exist, and stays open.
  assert.equal(await as(bob, () => plugin.notifications.dismiss(mine.id)), false);
  assert.equal(await plugin.notifications.dismiss(mine.id), false, 'a job cannot dismiss a user\'s');
  assert.equal(await plugin.notifications.dismiss(system.id), false, 'nor a system one');
  assert.equal(dbApi.getNotification(mine.id)?.dismissed_at, null);
  assert.equal(await as(ada, () => plugin.notifications.dismiss(randomUUID())), false);
  await dispose();
});

test('filters, dismiss and the archive', async () => {
  const alert = raise(bob.id, 'f-alert', 'alert');
  const report = raise(bob.id, 'f-report', 'report');
  const { plugin, dispose } = await pluginWith(['notifications:read', 'notifications:write']);
  const alerts = await as(bob, () => plugin.notifications.list({ type: 'alert' }));
  assert.ok(alerts.every((n) => n.type === 'alert') && alerts.some((n) => n.id === alert.id));
  await assert.rejects(as(bob, () => plugin.notifications.list({ type: 'nope' as never })), (e) => e instanceof PluginNotificationError && e.code === 'invalid');

  const signals: unknown[] = [];
  const onBus = (ev: unknown) => { if ((ev as { kind?: string }).kind === 'notifications_changed') signals.push(ev); };
  bus.on('event', onBus);
  assert.equal(await as(bob, () => plugin.notifications.dismiss(report.id)), true);
  bus.off('event', onBus);
  assert.equal(signals.length, 1, 'the centre is told, as the route tells it');
  assert.equal(await as(bob, () => plugin.notifications.dismiss(report.id)), false, 'already closed');
  assert.equal((await as(bob, () => plugin.notifications.list())).some((n) => n.id === report.id), false);
  const archived = await as(bob, () => plugin.notifications.list({ active: false }));
  assert.deepEqual(archived.map((n) => n.id), [report.id]);
  assert.ok(archived[0]!.dismissedAt !== null);
  await dispose();
});

test('with the centre switched off the facade says so', async () => {
  const { plugin, dispose } = await pluginWith(['notifications:read', 'notifications:write']);
  setActiveModules(['@timon/missions']);
  try {
    await assert.rejects(as(ada, () => plugin.notifications.list()), (e) => e instanceof PluginNotificationError && e.code === 'module_disabled');
    await assert.rejects(as(ada, () => plugin.notifications.dismiss(randomUUID())), (e) => e instanceof PluginNotificationError && e.code === 'module_disabled');
  } finally {
    resetActiveModules();
  }
  await dispose();
});
