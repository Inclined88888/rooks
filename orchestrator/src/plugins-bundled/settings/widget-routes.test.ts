/**
 * The widget tools an agent reaches its owner's screen with, and the card the
 * owner answers. The refusals matter most: an anonymous caller, a browser
 * proposing, an agent writing anywhere but its owner's rows, another account
 * reading or answering a proposal, a widget of a plugin the owner was not
 * granted — at proposal time and again at the click.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { PluginPublic } from '../../plugins/public.js';

await import('../../../tests/helpers/paid-license.js');
const { registerWidgetRoutes } = await import('./widget-routes.js');
const { registerLayoutProposalRoutes, LAYOUT_PROPOSAL_EVENT } = await import('./layout-proposals.js');
const { workspaceKey, sharedPresetsKey, SNAPSHOT_SCOPE } = await import('./widget-model.js');
const { ISLAND_SNAPSHOT_SCOPE } = await import('./island-model.js');
const { dbApi } = await import('../../db.js');
const { startNotificationResolver } = await import('../../notifications.js');
const stopResolver = startNotificationResolver();

const owner = createTestAccount(dbApi, { email: 'w-owner@example.com', name: 'owner', passwordHash: 'x', isSuperadmin: true });
const stranger = createTestAccount(dbApi, { email: 'w-stranger@example.com', name: 'stranger', passwordHash: 'x', isSuperadmin: true });
const ungranted = createTestAccount(dbApi, { email: 'w-nogrant@example.com', name: 'nogrant', passwordHash: 'x', isSuperadmin: false });
dbApi.createMission('w-mission', 'acme.coder', 'arrange my screen', undefined, owner.id);
dbApi.createMission('w-orphan', 'acme.coder', 'work', undefined, null);
dbApi.createMission('w-nogrant', 'acme.coder', 'work', undefined, ungranted.id);

const plugin = (id: string, state: PluginPublic['state'] = 'active') =>
  ({ id, state, kind: ['widget'], source: 'bundled', route: null, slots: ['chat.right.widget'] }) as unknown as PluginPublic;
let plugins: PluginPublic[] = [plugin('@timon/git'), plugin('@timon/missions')];
const late: Array<{ missionId: string; text: string }> = [];

type Fake = { kind: 'daemon-token' | 'session' | 'api-token'; userId?: string; missionId?: string | null };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const raw = req.header('x-test-auth');
  if (raw) {
    const fake = JSON.parse(raw) as Fake;
    const user = fake.userId ? dbApi.getUserById(fake.userId) ?? null : null;
    req.auth = {
      kind: fake.kind, user,
      isSuperadmin: fake.kind === 'daemon-token' || !!user?.is_superadmin,
      missionId: fake.missionId ?? null,
      ...(fake.kind === 'api-token' ? { permissions: [] } : {}),
    };
  }
  next();
});
registerWidgetRoutes(app, { plugins: () => plugins });
registerLayoutProposalRoutes(app, { deliver: (missionId, text) => { late.push({ missionId, text }); } });
const server = createServer(app);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); stopResolver(); });

const asOwner: Fake = { kind: 'session', userId: owner.id };
const asStranger: Fake = { kind: 'session', userId: stranger.id };
const asAgent: Fake = { kind: 'api-token', userId: owner.id, missionId: 'w-mission' };

async function call(method: string, path: string, who: Fake | null, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { 'x-test-auth': JSON.stringify(who) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

const snapshot = {
  catalog: [
    { id: 'plugin:@timon/git:Git', title: 'Git', pluginId: '@timon/git', slots: ['chat.right.widget'] },
    { id: 'plugin:@timon/missions:Missions', title: 'Missions', pluginId: '@timon/missions', slots: ['chat.left.widget'] },
  ],
  defaults: { '/chat': [{ id: 'plugin:@timon/missions:Missions', zone: 'chat.left.widget', rank: 0 }] },
  view: { path: '/chat', zones: [{ id: 'chat.left.widget', slot: 'chat.left.widget' }] },
};

test('every route refuses an anonymous caller', async () => {
  for (const [method, path] of [
    ['GET', '/api/widgets'], ['PUT', '/api/widgets/snapshot'], ['POST', '/api/widgets/proposals'],
    ['POST', '/api/widgets/presets'], ['GET', '/api/layout/proposals'],
    ['POST', '/api/layout/proposals/00000000-0000-4000-8000-000000000000/resolve'],
  ] as const) {
    const r = await call(method, path, null, method === 'GET' ? undefined : {});
    assert.equal(r.status, 401, `${method} ${path}`);
  }
});

test('the catalog is published by a signed-in browser only', async () => {
  assert.equal((await call('PUT', '/api/widgets/snapshot', asAgent, snapshot)).status, 403);
  assert.equal((await call('PUT', '/api/widgets/snapshot', { kind: 'daemon-token', userId: owner.id }, snapshot)).status, 403);
  assert.equal((await call('PUT', '/api/widgets/snapshot', asOwner, { catalog: 'nope' })).status, 400);
  assert.equal((await call('PUT', '/api/widgets/snapshot', asOwner, snapshot)).status, 200);
  assert.ok(dbApi.uiLayoutGetOwn(owner.id, SNAPSHOT_SCOPE));
  assert.equal(dbApi.uiLayoutGetOwn(stranger.id, SNAPSHOT_SCOPE), undefined);
});

test('an agent reads its owner\'s chat by default, with titles and starters', async () => {
  const r = await call('GET', '/api/widgets', asAgent);
  assert.equal(r.status, 200);
  assert.equal(r.json.view, '/chat');
  assert.equal(r.json.customised, false);
  const zones = r.json.zones as Array<{ id: string; widgets: Array<{ id: string; title: string }> }>;
  assert.deepEqual(zones.find((z) => z.id === 'chat.left.widget')?.widgets, [{ id: 'plugin:@timon/missions:Missions', title: 'Missions' }]);
  assert.deepEqual((r.json.palette as Array<{ id: string }>).map((p) => p.id), ['plugin:@timon/git:Git']);
  // The stranger has published nothing: their screen is not the owner's.
  const theirs = await call('GET', '/api/widgets', asStranger);
  assert.deepEqual(theirs.json.catalog, []);
});

test('a mission without an owner, or acting for another account, is refused', async () => {
  assert.equal((await call('GET', '/api/widgets', { kind: 'api-token', missionId: 'w-orphan' })).status, 409);
  assert.equal((await call('GET', '/api/widgets', { kind: 'api-token', userId: stranger.id, missionId: 'w-mission' })).status, 403);
});

let proposalId = '';

test('only an agent proposes; a valid proposal becomes a card in its conversation', async () => {
  const body = { zones: { 'chat.right.widget': ['plugin:@timon/git:Git'] }, note: 'Git beside the thread' };
  assert.equal((await call('POST', '/api/widgets/proposals', asOwner, body)).status, 403);
  assert.equal((await call('POST', '/api/widgets/proposals', { kind: 'daemon-token', userId: owner.id }, body)).status, 403);
  const r = await call('POST', '/api/widgets/proposals', asAgent, body);
  assert.equal(r.status, 202);
  assert.equal(r.json.status, 'pending');
  proposalId = r.json.id as string;
  const events = dbApi.listEvents('w-mission').filter((e) => e.type === LAYOUT_PROPOSAL_EVENT);
  assert.equal(events.length, 1);
  assert.equal(dbApi.getLayoutProposal(proposalId)?.owner_user_id, owner.id);
});

test('a proposal naming an unknown zone or widget, or too large, is refused before any card', async () => {
  const unknownZone = await call('POST', '/api/widgets/proposals', asAgent, { zones: { nowhere: ['plugin:@timon/git:Git'] } });
  assert.equal(unknownZone.status, 400);
  assert.equal((unknownZone.json.problems as Array<{ code: string }>)[0]?.code, 'unknown_zone');
  assert.equal((await call('POST', '/api/widgets/proposals', asAgent, { zones: { 'chat.left.widget': ['plugin:@timon/ghost'] } })).status, 400);
  assert.equal((await call('POST', '/api/widgets/proposals', asAgent, {})).status, 400);
  const huge = await call('POST', '/api/widgets/proposals', asAgent, { remove: ['x'.repeat(20 * 1024)] });
  assert.equal(huge.status, 413);
});

test('a widget of a plugin the owner was not granted, or that is off, is refused', async () => {
  // Same catalog, published by an account that holds no grant at all.
  dbApi.uiLayoutSet(ungranted.id, SNAPSHOT_SCOPE, dbApi.uiLayoutGetOwn(owner.id, SNAPSHOT_SCOPE)!.value);
  const r = await call('POST', '/api/widgets/proposals', { kind: 'api-token', userId: ungranted.id, missionId: 'w-nogrant' },
    { zones: { 'chat.right.widget': ['plugin:@timon/git:Git'] } });
  assert.equal(r.status, 400);
  assert.equal((r.json.problems as Array<{ code: string }>)[0]?.code, 'unknown_widget');
  plugins = [plugin('@timon/git', 'disabled'), plugin('@timon/missions')];
  try {
    const off = await call('POST', '/api/widgets/proposals', asAgent, { zones: { 'chat.right.widget': ['plugin:@timon/git:Git'] } });
    assert.equal(off.status, 400);
  } finally {
    plugins = [plugin('@timon/git'), plugin('@timon/missions')];
  }
});

test('another account neither lists nor answers the proposal', async () => {
  const list = await call('GET', '/api/layout/proposals?mission_id=w-mission', asStranger);
  assert.deepEqual(list.json.proposals, []);
  assert.equal((await call('POST', `/api/layout/proposals/${proposalId}/resolve`, asStranger, { decision: 'applied' })).status, 404);
  assert.equal((await call('POST', `/api/layout/proposals/${proposalId}/resolve`, asAgent, { decision: 'applied' })).status, 403,
    'the agent cannot apply its own proposal');
  assert.equal(dbApi.getLayoutProposal(proposalId)?.status, 'pending');
});

test('a grant withdrawn before the click makes the proposal stale', async () => {
  plugins = [plugin('@timon/git', 'disabled'), plugin('@timon/missions')];
  try {
    const r = await call('POST', `/api/layout/proposals/${proposalId}/resolve`, asOwner, { decision: 'applied' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'stale');
  } finally {
    plugins = [plugin('@timon/git'), plugin('@timon/missions')];
  }
});

test('the owner applies once; the agent hears it; a second answer is refused', async () => {
  const list = await call('GET', '/api/layout/proposals?mission_id=w-mission', asOwner);
  assert.equal((list.json.proposals as unknown[]).length, 1);
  const active = () => dbApi.listActiveNotificationsByMission('w-mission', 'action_required').filter((n) => n.anchor === proposalId);
  assert.equal(active().length, 1, 'the card is announced in the notification center');
  const ok = await call('POST', `/api/layout/proposals/${proposalId}/resolve`, asOwner, { decision: 'applied', origin: 'chat_card' });
  assert.equal(ok.status, 200);
  assert.equal(active().length, 0, 'answering the card dismisses its notification');
  assert.equal(dbApi.getLayoutProposal(proposalId)?.status, 'applied');
  assert.match(late.at(-1)?.text ?? '', /applied your widget arrangement/);
  assert.equal((await call('POST', `/api/layout/proposals/${proposalId}/resolve`, asOwner, { decision: 'dismissed' })).status, 409);
});

test('a preset is saved in the owner\'s presets row, never another account\'s', async () => {
  const key = workspaceKey(owner.id, '/', null);
  dbApi.uiLayoutSet(owner.id, `${key}.widgets`, JSON.stringify([{ id: 'plugin:@timon/git:Git', rail: 'gauche', rang: 0, hauteur: 200 }]));
  const r = await call('POST', '/api/widgets/presets', asAgent, { name: 'Focus', view: '/' });
  assert.equal(r.status, 200);
  const stored = JSON.parse(dbApi.uiLayoutGetOwn(owner.id, sharedPresetsKey(owner.id, '/'))!.value) as { v: number; presets: Array<{ name: string; scopes: Record<string, unknown> }> };
  assert.equal(stored.v, 1);
  assert.equal(stored.presets[0]?.name, 'Focus');
  assert.deepEqual(Object.keys(stored.presets[0]!.scopes), ['widgets']);
  assert.equal(dbApi.uiLayoutGetOwn(stranger.id, sharedPresetsKey(stranger.id, '/')), undefined);
  assert.equal((await call('POST', '/api/widgets/presets', asAgent, { name: 'focus', view: '/' })).status, 409);
  assert.equal((await call('POST', '/api/widgets/presets', asAgent, { name: 'focus', view: '/', replace: true })).status, 200);
  assert.equal((await call('POST', '/api/widgets/presets', { kind: 'daemon-token', userId: owner.id }, { name: 'x' })).status, 403);
});

test('a preset of islands keeps the agents and drops the conversations the owner\'s types declare volatile', async () => {
  const key = workspaceKey(owner.id, '/kanban', null);
  dbApi.uiLayoutSet(owner.id, ISLAND_SNAPSHOT_SCOPE, JSON.stringify({
    at: 1,
    types: [{ type: '@timon/missions:chat', title: 'Chat', volatileParams: ['missionId', 'fresh'] }],
  }));
  dbApi.uiLayoutSet(owner.id, `${key}.islands`, JSON.stringify({
    v: 1, focus: 'l1',
    root: { id: 'l1', kind: 'leaf', active: 'c1', tabs: [
      { id: 'r1', content: { type: 'host:route', params: {} } },
      { id: 'c1', content: { type: '@timon/missions:chat', params: { agent: 'acme.coder', missionId: 'w-mission', fresh: false } } },
    ] },
  }));
  const r = await call('POST', '/api/widgets/presets', asAgent, { name: 'Board', view: '/kanban' });
  assert.equal(r.status, 200);
  const stored = JSON.parse(dbApi.uiLayoutGetOwn(owner.id, sharedPresetsKey(owner.id, '/kanban'))!.value) as {
    presets: Array<{ scopes: { islands: { root: { tabs: Array<{ content: { params: Record<string, unknown> } }> } } } }>;
  };
  assert.deepEqual(stored.presets[0]!.scopes.islands.root.tabs[1]!.content.params, { agent: 'acme.coder' });
  // The view itself still reopens the same conversation.
  assert.match(dbApi.uiLayoutGetOwn(owner.id, `${key}.islands`)!.value, /w-mission/);
});
