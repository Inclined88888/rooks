/**
 * `ctx.layout`, `ctx.ui.navigate`, `ctx.onboarding` and `ctx.chat` (API 10) as
 * a THIRD-PARTY plugin reaches them. The refusals come first: a permission the
 * manifest did not declare, a job (no account), another account's mission, a
 * superadmin who sees a mission without owning it, a widget the owner may not
 * see — and, every time, proof that nothing was applied (the card is `pending`,
 * the layout rows are as they were) and that the mission's agent was not spoken to.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-plugin-layout-'));
await import('../../tests/helpers/paid-license.js');
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError } = await import('./context.js');
const { PluginLayoutError } = await import('./layout-facade.js');
const { PluginPolicyError, resetPluginPolicyState } = await import('./policy.js');
const { RooksConfigSchema } = await import('../config/schema.js');
const { setConfig, resetConfig } = await import('../config/load.js');
const { runPluginRequest } = await import('./als.js');
const { setGallerySource } = await import('./runtime.js');
const { dbApi } = await import('../db.js');
const { bus } = await import('../bus.js');
const { resolveLayoutProposal } = await import('../plugins-bundled/settings/layout-proposals.js');
const { resolveCommandRequest } = await import('../plugins-bundled/terminal-web/command-requests.js');
const { SNAPSHOT_SCOPE, SnapshotBody, mergeSnapshot, workspaceKey, WIDGETS_SUFFIX } = await import('../plugins-bundled/settings/widget-model.js');
const { NAVIGATE_GRANT_SCOPE } = await import('../plugins-bundled/settings/navigate-routes.js');
const { ONBOARDING_PROFILE_SCOPE } = await import('../plugins-bundled/settings/onboarding-profile-routes.js');
import type { PluginPublic } from './public.js';

const A = 'plugin-a';
const B = 'plugin-b';

const make = (name: string, isSuperadmin: boolean) =>
  createTestAccount(dbApi, { id: randomUUID(), email: `${name}-${randomUUID()}@example.test`, name, passwordHash: 'unused', isSuperadmin });
const ada = make('ada', true);
const bob = make('bob', true);
const root = make('root', true);
// Not a superadmin, no grant: sees no widget of any plugin.
const dana = make('dana', false);
dbApi.createMission('m-ada', 'rooks.coder', 'work', undefined, ada.id);
dbApi.createMission('m-bob', 'rooks.coder', 'work', undefined, bob.id);
dbApi.createMission('m-dana', 'rooks.coder', 'work', undefined, dana.id);
dbApi.createMission('m-job-a', 'rooks.coder', 'work', undefined, `plugin:${A}`);

const widgetPlugin = (id: string) =>
  ({ id, state: 'active', kind: ['widget'], source: 'bundled', route: null, slots: ['chat.right.widget'] }) as unknown as PluginPublic;
setGallerySource(() => [widgetPlugin('@rooks/git'), widgetPlugin('@rooks/missions')]);

const catalog = SnapshotBody.parse({
  catalog: [
    { id: 'plugin:@rooks/git:Git', title: 'Git', pluginId: '@rooks/git', slots: ['chat.right.widget'] },
    { id: 'plugin:@rooks/missions:Missions', title: 'Missions', pluginId: '@rooks/missions', slots: ['chat.left.widget'] },
  ],
  defaults: {},
  view: { path: '/chat', zones: [{ id: 'chat.left.widget', slot: 'chat.left.widget' }, { id: 'chat.right.widget', slot: 'chat.right.widget' }] },
});
for (const user of [ada, dana]) dbApi.uiLayoutSet(user.id, SNAPSHOT_SCOPE, JSON.stringify(mergeSnapshot(null, catalog, Date.now())));

const GIT = 'plugin:@rooks/git:Git';

function identityOf(user: { id: string; email: string; name: string; is_superadmin: boolean }) {
  return {
    viewer: { id: user.id, isSuperadmin: user.is_superadmin, permissions: dbApi.listPermissionsForUser(user.id) },
    user: { id: user.id, email: user.email, name: user.name, is_superadmin: user.is_superadmin },
    ownerUserId: user.id,
  };
}
const as = (user: Parameters<typeof identityOf>[0]) => <T>(fn: () => Promise<T>) => runPluginRequest(identityOf(user), fn);
const asAda = as(ada);
const asBob = as(bob);
const asRoot = as(root);
const asDana = as(dana);

async function pluginWith(id: string, permissions: string[]) {
  const ctxRoot = new Context();
  let inner!: Context;
  await ctxRoot.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ rooks: { id, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(ctxRoot));
  return { plugin, dispose: () => ctxRoot.fiber.dispose() };
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try { await fn(); } catch (err) {
    return err instanceof PluginLayoutError ? err.code : `other: ${String(err)}`;
  }
  return undefined;
}

const ALL = ['layout:read', 'layout:propose', 'layout:presets', 'chat:media', 'chat:command', 'onboarding:read'];

const pendingCards = (missionId: string) =>
  dbApi.listLayoutProposals({ ownerUserId: dbApi.getMission(missionId)!.owner_user_id!, missionId });
const widgetsRow = (userId: string) => dbApi.uiLayoutGetOwn(userId, `${workspaceKey(userId, '/chat', null)}.${WIDGETS_SUFFIX}`)?.value;

/** The agent's late-delivery channel must stay silent for a card a plugin raised. */
const toAgent: string[] = [];
const deliver = (_mission: string, text: string): void => { toAgent.push(text); };

test('the API version is 10 and the new permissions are declarable', () => {
  assert.ok(PLUGIN_API_VERSION >= 10);
  const res = readManifest({ rooks: { id: A, apiVersion: 10, permissions: ALL } });
  assert.equal(res.ok, true);
});

test('a permission the manifest did not declare is refused before anything is read or written', async () => {
  const reader = await pluginWith(A, ['layout:read']);
  await assert.rejects(asAda(() => reader.plugin.layout.widgets.propose({ missionId: 'm-ada', zones: { 'chat.right.widget': [GIT] } })), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.layout.islands.propose({ missionId: 'm-ada' })), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.layout.nav.propose({ missionId: 'm-ada', hidden: [] })), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.ui.navigate({ missionId: 'm-ada', path: '/chat' })), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.layout.widgets.presetSave({ name: 'x' })), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.layout.proposals.list()), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.chat.showMedia({ missionId: 'm-ada', src: '/x.png' })), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.chat.proposeCommand({ missionId: 'm-ada', command: 'ls' })), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.onboarding.profile()), PluginPermissionError);
  assert.equal(pendingCards('m-ada').length, 0);
  const proposer = await pluginWith(A, ['layout:propose', 'chat:command', 'chat:media']);
  await assert.rejects(asAda(() => proposer.plugin.layout.widgets.get()), PluginPermissionError);
  await assert.rejects(asAda(() => proposer.plugin.layout.nav.get()), PluginPermissionError);
  await assert.rejects(asAda(() => proposer.plugin.layout.islands.get()), PluginPermissionError);
  const none = await pluginWith(A, []);
  await assert.rejects(asAda(() => none.plugin.layout.widgets.get()), PluginPermissionError);
  await reader.dispose(); await proposer.dispose(); await none.dispose();
});

test('a job has no account: every call answers no_owner, nothing is written', async () => {
  const { plugin, dispose } = await pluginWith(A, ALL);
  const before = dbApi.listEvents('m-job-a').length;
  assert.equal(await codeOf(() => plugin.layout.widgets.get()), 'no_owner');
  assert.equal(await codeOf(() => plugin.layout.islands.get()), 'no_owner');
  assert.equal(await codeOf(() => plugin.layout.nav.get()), 'no_owner');
  assert.equal(await codeOf(() => plugin.layout.widgets.propose({ missionId: 'm-job-a', remove: [GIT] })), 'no_owner');
  assert.equal(await codeOf(() => plugin.layout.islands.propose({ missionId: 'm-job-a' })), 'no_owner');
  assert.equal(await codeOf(() => plugin.layout.nav.propose({ missionId: 'm-job-a', hidden: [] })), 'no_owner');
  assert.equal(await codeOf(() => plugin.ui.navigate({ missionId: 'm-job-a', path: '/chat' })), 'no_owner');
  assert.equal(await codeOf(() => plugin.layout.widgets.presetSave({ name: 'job' })), 'no_owner');
  assert.equal(await codeOf(() => plugin.onboarding.profile()), 'no_owner');
  assert.equal(await codeOf(() => plugin.chat.showMedia({ missionId: 'm-job-a', src: '/x.png' })), 'no_owner');
  assert.equal(await codeOf(() => plugin.chat.proposeCommand({ missionId: 'm-job-a', command: 'ls' })), 'no_owner');
  assert.deepEqual(await plugin.layout.proposals.list(), []);
  assert.equal(await plugin.layout.proposals.get(randomUUID()), undefined);
  assert.equal(dbApi.listEvents('m-job-a').length, before, 'no card, no event');
  assert.equal(pendingCards('m-job-a').length, 0);
  await dispose();
});

test('a widget proposal is a pending card of the plugin, applied by nobody, unseen by the agent', async () => {
  const { plugin, dispose } = await pluginWith(A, ALL);
  const before = widgetsRow(ada.id);
  const read = await asAda(() => plugin.layout.widgets.get({ view: '/chat' }));
  assert.equal(read.view, '/chat');
  const events: string[] = [];
  const listener = (ev: { kind: string; type?: string }) => { if (ev.kind === 'event' && ev.type) events.push(ev.type); };
  bus.on('event', listener as never);
  const got = await asAda(() => plugin.layout.widgets.propose({
    missionId: 'm-ada', view: '/chat', zones: { 'chat.right.widget': [GIT] }, note: 'Git on the right',
  }));
  bus.off('event', listener as never);
  assert.equal(got.status, 'pending');
  assert.ok(events.includes('layout_proposal'), 'the card is in the conversation');
  const row = dbApi.getLayoutProposal(got.id)!;
  assert.equal(row.status, 'pending');
  assert.equal(row.origin_kind, 'plugin');
  assert.equal(row.origin_id, A);
  assert.equal(row.agent, `plugin:${A}`, 'the card shows the plugin, not the mission\'s agent');
  assert.equal(row.owner_user_id, ada.id);
  assert.equal(widgetsRow(ada.id), before, 'the arrangement was not touched');
  const audited = dbApi.listAuditLog(500).find((a) => a.action === 'widgets.propose' && a.target === got.id);
  assert.equal(audited?.actor, `plugin:${A}`, 'the audit row names the plugin and the account it acted for');
  assert.equal(audited?.user_id, ada.id);

  // The owner decides: the agent is not told, the plugin reads the answer.
  toAgent.length = 0;
  const settled = resolveLayoutProposal(got.id, 'applied', 'test', deliver);
  assert.ok(settled.ok);
  assert.deepEqual(toAgent, [], 'the mission\'s agent proposed nothing: it hears nothing');
  const seen = await asAda(() => plugin.layout.proposals.get(got.id));
  assert.equal(seen?.status, 'applied');
  assert.equal(seen?.missionId, 'm-ada');
  assert.ok((await asAda(() => plugin.layout.proposals.list({ status: 'applied' }))).some((p) => p.id === got.id));
  await dispose();
});

test('an agent\'s own proposal still reaches the agent (the default is unchanged)', async () => {
  const { createLayoutProposal } = await import('../plugins-bundled/settings/layout-proposals.js');
  const row = createLayoutProposal({ id: randomUUID(), kind: 'widgets', mission: dbApi.getMission('m-ada')!, owner: ada, payload: { view: '/chat' } });
  assert.equal(row.origin_kind, 'agent');
  assert.equal(row.agent, 'rooks.coder');
  toAgent.length = 0;
  resolveLayoutProposal(row.id, 'dismissed', 'test', deliver);
  assert.equal(toAgent.length, 1);
});

test('another account\'s mission, an absent one, and a superadmin\'s sight of a mission are all not_found', async () => {
  const { plugin, dispose } = await pluginWith(A, ALL);
  const input = { zones: { 'chat.right.widget': [GIT] } };
  const cardsBefore = dbApi.listLayoutProposals({ ownerUserId: ada.id }).length + dbApi.listLayoutProposals({ ownerUserId: root.id }).length;
  assert.equal(await codeOf(() => asBob(() => plugin.layout.widgets.propose({ missionId: 'm-ada', ...input }))), 'not_found');
  assert.equal(await codeOf(() => asAda(() => plugin.layout.widgets.propose({ missionId: randomUUID(), ...input }))), 'not_found');
  // `root` is a superadmin: the viewer sees every mission, yet none is root's.
  assert.equal(await codeOf(() => asRoot(() => plugin.layout.widgets.propose({ missionId: 'm-ada', ...input }))), 'not_found');
  assert.equal(await codeOf(() => asRoot(() => plugin.layout.nav.propose({ missionId: 'm-ada', hidden: [] }))), 'not_found');
  assert.equal(await codeOf(() => asRoot(() => plugin.ui.navigate({ missionId: 'm-ada', path: '/chat' }))), 'not_found');
  assert.equal(await codeOf(() => asRoot(() => plugin.chat.proposeCommand({ missionId: 'm-ada', command: 'ls' }))), 'not_found');
  assert.equal(await codeOf(() => asRoot(() => plugin.chat.showMedia({ missionId: 'm-ada', src: '/x.png' }))), 'not_found');
  assert.equal(await codeOf(() => asAda(() => plugin.layout.widgets.propose({ missionId: undefined as never, ...input }))), 'not_found');
  assert.equal(dbApi.listLayoutProposals({ ownerUserId: ada.id }).length + dbApi.listLayoutProposals({ ownerUserId: root.id }).length, cardsBefore, 'no card was raised');
  await dispose();
});

test('a widget of a plugin the owner may not see is refused, and nothing is stored', async () => {
  const { plugin, dispose } = await pluginWith(A, ALL);
  const before = pendingCards('m-dana').length;
  const err = await asDana(() => plugin.layout.widgets.propose({ missionId: 'm-dana', view: '/chat', zones: { 'chat.right.widget': [GIT] } })).catch((e) => e);
  assert.ok(err instanceof PluginLayoutError);
  assert.equal(err.code, 'invalid_proposal');
  assert.ok(Array.isArray(err.details) && err.details.length > 0, 'the problems are returned');
  assert.equal(pendingCards('m-dana').length, before);
  const read = await asDana(() => plugin.layout.widgets.get({ view: '/chat' }));
  assert.deepEqual(read.catalog, [], 'the catalog Dana reads has no widget she may not use');
  await dispose();
});

test('an unknown field, an empty change and an unpublished catalog are typed refusals', async () => {
  const { plugin, dispose } = await pluginWith(A, ALL);
  assert.equal(await codeOf(() => asAda(() => plugin.layout.widgets.propose({ missionId: 'm-ada', frobnicate: true } as never))), 'invalid');
  assert.equal(await codeOf(() => asAda(() => plugin.layout.widgets.propose({ missionId: 'm-ada' }))), 'invalid');
  assert.equal(await codeOf(() => asAda(() => plugin.layout.widgets.propose(null as never))), 'invalid');
  // Bob never opened Rooks in a browser: no catalog, so no widget can be named yet.
  assert.equal(await codeOf(() => asBob(() => plugin.layout.widgets.propose({ missionId: 'm-bob', view: '/chat', remove: [GIT] }))), 'no_snapshot');
  await dispose();
});

test('proposals are readable by the plugin that raised them, for the account that owns them, and by no other', async () => {
  const a = await pluginWith(A, ALL);
  const b = await pluginWith(B, ALL);
  const mine = await asAda(() => a.plugin.layout.nav.propose({ missionId: 'm-ada', hidden: ['/kanban'] }));
  assert.equal(await asAda(() => b.plugin.layout.proposals.get(mine.id)), undefined, 'plugin B');
  assert.equal(await asBob(() => a.plugin.layout.proposals.get(mine.id)), undefined, 'account Bob');
  assert.equal(await asRoot(() => a.plugin.layout.proposals.get(mine.id)), undefined, 'a superadmin who does not own it');
  assert.ok(!(await asAda(() => b.plugin.layout.proposals.list())).some((p) => p.id === mine.id));
  assert.ok(!(await asBob(() => a.plugin.layout.proposals.list())).some((p) => p.id === mine.id));
  assert.ok((await asAda(() => a.plugin.layout.proposals.list({ missionId: 'm-ada' }))).some((p) => p.id === mine.id));
  await a.dispose(); await b.dispose();
});

test('navigate always raises a card, even under a live guided tour of that mission', async () => {
  const { plugin, dispose } = await pluginWith(A, ALL);
  dbApi.uiLayoutSet(ada.id, NAVIGATE_GRANT_SCOPE, JSON.stringify({ missionId: 'm-ada', until: Date.now() + 60_000 }));
  const moved: unknown[] = [];
  const onBus = (ev: { kind: string }) => { if (ev.kind === 'ui_navigate') moved.push(ev); };
  bus.on('event', onBus as never);
  const got = await asAda(() => plugin.ui.navigate({ missionId: 'm-ada', path: '/chat', note: 'Look here' }));
  bus.off('event', onBus as never);
  assert.equal(got.status, 'pending');
  assert.equal(moved.length, 0, 'the screen did not move');
  assert.equal(dbApi.getLayoutProposal(got.id)?.origin_id, A);
  assert.equal(dbApi.getLayoutProposal(got.id)?.kind, 'navigate');
  assert.equal(await codeOf(() => asAda(() => plugin.ui.navigate({ missionId: 'm-ada', path: 'not a path' }))), 'invalid');
  dbApi.uiLayoutSet(ada.id, NAVIGATE_GRANT_SCOPE, JSON.stringify({ missionId: '', until: 0 }));
  await dispose();
});

test('the menu: read, propose, refuse a bad page', async () => {
  const { plugin, dispose } = await pluginWith(A, ALL);
  const read = await asAda(() => plugin.layout.nav.get());
  assert.deepEqual(read.hidden, []);
  const got = await asAda(() => plugin.layout.nav.propose({ missionId: 'm-ada', hidden: ['/kanban'] }));
  assert.equal(dbApi.getLayoutProposal(got.id)?.kind, 'nav');
  const laidOut = await asAda(() => plugin.layout.nav.propose({ missionId: 'm-ada', order: ['/', '---', '/kanban'], footer: ['/plugins'] }));
  assert.deepEqual(JSON.parse(dbApi.getLayoutProposal(laidOut.id)!.payload), { order: ['/', '---', '/kanban'], footer: ['/plugins'] });
  assert.equal(await codeOf(() => asAda(() => plugin.layout.nav.propose({ missionId: 'm-ada', hidden: 'nope' as never }))), 'invalid');
  await dispose();
});

test('islands: a read, and a layout of a content type nobody published is refused', async () => {
  const { plugin, dispose } = await pluginWith(A, ALL);
  const read = await asAda(() => plugin.layout.islands.get({ view: '/chat' }));
  assert.equal(read.view, '/chat');
  assert.ok(await codeOf(() => asAda(() => plugin.layout.islands.propose({ missionId: 'm-ada', open: { content: { type: 'acme:nothing' }, edge: 'right' } }))));
  assert.equal(pendingCards('m-ada').filter((c) => c.kind === 'islands').length, 0);
  await dispose();
});

test('presets: saved for the account of the request, refused on a clash unless replaced', async () => {
  const { plugin, dispose } = await pluginWith(A, ALL);
  const saved = await asAda(() => plugin.layout.widgets.presetSave({ name: 'Focus', view: '/chat' }));
  assert.equal(saved.name, 'Focus');
  assert.equal(saved.replaced, false);
  assert.equal(await codeOf(() => asAda(() => plugin.layout.widgets.presetSave({ name: 'Focus', view: '/chat' }))), 'conflict');
  assert.equal((await asAda(() => plugin.layout.islands.presetSave({ name: 'Focus', view: '/chat', replace: true }))).replaced, true);
  assert.equal(await codeOf(() => asAda(() => plugin.layout.widgets.presetSave({ name: '' }))), 'invalid');
  // Bob's presets are his own: Ada's `Focus` is not a clash for him.
  assert.equal((await asBob(() => plugin.layout.widgets.presetSave({ name: 'Focus', view: '/chat' }))).replaced, false);
  await dispose();
});

test('the onboarding profile is the account\'s own', async () => {
  const { plugin, dispose } = await pluginWith(A, ALL);
  assert.deepEqual(await asAda(() => plugin.onboarding.profile()), { profile: null, at: null });
  dbApi.uiLayoutSet(ada.id, ONBOARDING_PROFILE_SCOPE, JSON.stringify({ profile: 'developer', at: 42 }));
  assert.deepEqual(await asAda(() => plugin.onboarding.profile()), { profile: 'developer', at: 42 });
  assert.deepEqual(await asBob(() => plugin.onboarding.profile()), { profile: null, at: null });
  await dispose();
});

test('a command is a pending card for the owner to paste or dismiss, never waited for, never run, never audited in clear', async () => {
  const { plugin, dispose } = await pluginWith(A, ALL);
  const secret = `rm -rf /tmp/${randomUUID()}`;
  const got = await asAda(() => plugin.chat.proposeCommand({ missionId: 'm-ada', command: secret, note: 'cleanup' }));
  assert.equal(got.status, 'pending');
  assert.deepEqual([...got.choices].sort(), ['deny', 'paste'], '`allow` asks an agent to run it: none raised this');
  const row = dbApi.getCommandRequest(got.id)!;
  assert.equal(row.origin_kind, 'plugin');
  assert.equal(row.origin_id, A);
  assert.equal(row.agent, `plugin:${A}`);
  assert.equal(row.status, 'pending');
  assert.ok(!JSON.stringify(dbApi.listAuditLog(500)).includes(secret));
  assert.ok(dbApi.listAuditLog(500).some((a) => a.action === 'terminal.propose' && a.target === got.id));
  assert.equal((await asAda(() => plugin.chat.commandRequests.get(got.id)))?.status, 'pending');
  toAgent.length = 0;
  const out = resolveCommandRequest(got.id, 'paste', 'test', { deliver });
  assert.ok(out.ok);
  assert.deepEqual(toAgent, [], 'the agent is not told the user pasted a command it never proposed');
  assert.equal((await asAda(() => plugin.chat.commandRequests.get(got.id)))?.status, 'paste');
  // Not allowed on a plugin's card.
  const second = await asAda(() => plugin.chat.proposeCommand({ missionId: 'm-ada', command: 'ls' }));
  assert.equal(resolveCommandRequest(second.id, 'allow', 'test', { deliver }).ok, false);
  // Others read nothing of it.
  const other = await pluginWith(B, ALL);
  assert.equal(await asAda(() => other.plugin.chat.commandRequests.get(got.id)), undefined);
  assert.equal(await asBob(() => plugin.chat.commandRequests.get(got.id)), undefined);
  await other.dispose();
  await dispose();
});

test('a command that is not one printable line is refused', async () => {
  const { plugin, dispose } = await pluginWith(A, ALL);
  for (const command of ['ls\nrm -rf /', 'ls\u001b[2J', '', '   ']) {
    assert.equal(await codeOf(() => asAda(() => plugin.chat.proposeCommand({ missionId: 'm-ada', command }))), 'invalid', JSON.stringify(command));
  }
  await dispose();
});

test('media: a file of the mission is shown to its owner; a path outside, another\'s mission and a bad source are refused', async () => {
  const { plugin, dispose } = await pluginWith(A, ALL);
  const dir = mkdtempSync(join(tmpdir(), 'rooks-plugin-media-'));
  const outside = mkdtempSync(join(tmpdir(), 'rooks-plugin-media-out-'));
  mkdirSync(join(dir, 'a'));
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  writeFileSync(join(dir, 'a', 'ok.png'), PNG);
  writeFileSync(join(outside, 'secret.png'), PNG);
  writeFileSync(join(dir, 'fake.png'), 'not an image at all');
  dbApi.setMissionCwdOverride('m-ada', dir);
  const events: string[] = [];
  const onEvent = (ev: { kind: string; type?: string }) => { if (ev.kind === 'event' && ev.type) events.push(ev.type); };
  bus.on('event', onEvent as never);
  const shown = await asAda(() => plugin.chat.showMedia({ missionId: 'm-ada', src: join(dir, 'a', 'ok.png'), caption: 'ok' }));
  bus.off('event', onEvent as never);
  assert.equal(shown.kind, 'image');
  assert.ok(events.includes('media'));
  assert.equal(await codeOf(() => asAda(() => plugin.chat.showMedia({ missionId: 'm-ada', src: join(outside, 'secret.png') }))), 'refused');
  assert.equal(await codeOf(() => asAda(() => plugin.chat.showMedia({ missionId: 'm-ada', src: join(dir, 'fake.png') }))), 'refused');
  assert.equal(await codeOf(() => asAda(() => plugin.chat.showMedia({ missionId: 'm-ada', src: 'http://example.com/x.png' }))), 'refused');
  assert.equal(await codeOf(() => asAda(() => plugin.chat.showMedia({ missionId: 'm-ada' } as never))), 'invalid');
  assert.equal(await codeOf(() => asBob(() => plugin.chat.showMedia({ missionId: 'm-ada', src: join(dir, 'a', 'ok.png') }))), 'not_found');
  await dispose();
});

test('an https media source is `ctx.fetch` by another name: it needs http:outbound and the operator\'s allowlist', async () => {
  const onlyMedia = await pluginWith(A, ['chat:media']);
  const withHttp = await pluginWith(A, ['chat:media', 'http:outbound']);
  try {
    const src = 'https://cdn.example.com/chart.png';
    // Declared nothing: refused before the daemon fetches anything.
    await assert.rejects(asAda(() => onlyMedia.plugin.chat.showMedia({ missionId: 'm-ada', src })), PluginPermissionError);
    // Declared, but the operator allowed no host (the default).
    setConfig(RooksConfigSchema.parse({ pluginPolicy: {} }));
    resetPluginPolicyState();
    await assert.rejects(asAda(() => withHttp.plugin.chat.showMedia({ missionId: 'm-ada', src })), PluginPolicyError);
    // Allowed for another host only.
    setConfig(RooksConfigSchema.parse({ pluginPolicy: { http: { allow: ['api.example.com'] } } }));
    resetPluginPolicyState();
    await assert.rejects(asAda(() => withHttp.plugin.chat.showMedia({ missionId: 'm-ada', src })), PluginPolicyError);
    // A local file and a data: image never needed the network: the permission is not asked for them.
    const dir = mkdtempSync(join(tmpdir(), 'rooks-plugin-media-local-'));
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
    writeFileSync(join(dir, 'ok.png'), PNG);
    dbApi.setMissionCwdOverride('m-ada', dir);
    assert.equal((await asAda(() => onlyMedia.plugin.chat.showMedia({ missionId: 'm-ada', src: join(dir, 'ok.png') }))).kind, 'image');
    const data = `data:image/png;base64,${PNG.toString('base64')}`;
    assert.equal((await asAda(() => onlyMedia.plugin.chat.showMedia({ missionId: 'm-ada', src: data }))).kind, 'image');
  } finally {
    resetConfig();
    resetPluginPolicyState();
    await onlyMedia.dispose();
    await withHttp.dispose();
  }
});
