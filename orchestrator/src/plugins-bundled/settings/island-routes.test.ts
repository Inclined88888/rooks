/**
 * The island tools an agent reaches its owner's workspace with, and the card
 * the owner answers. The refusals matter most: an anonymous caller, a browser
 * proposing, another account reading or answering, a type of a plugin the
 * owner was not granted, a target island gone before the click.
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
const { registerIslandRoutes } = await import('./island-routes.js');
const { registerLayoutProposalRoutes, LAYOUT_PROPOSAL_EVENT } = await import('./layout-proposals.js');
const { workspaceKey } = await import('./widget-model.js');
const { ISLAND_SNAPSHOT_SCOPE } = await import('./island-model.js');
const { dbApi } = await import('../../db.js');

const owner = createTestAccount(dbApi, { email: 'i-owner@example.com', name: 'owner', passwordHash: 'x', isSuperadmin: true });
const stranger = createTestAccount(dbApi, { email: 'i-stranger@example.com', name: 'stranger', passwordHash: 'x', isSuperadmin: true });
const ungranted = createTestAccount(dbApi, { email: 'i-nogrant@example.com', name: 'nogrant', passwordHash: 'x', isSuperadmin: false });
dbApi.createMission('i-mission', 'acme.coder', 'arrange my islands', undefined, owner.id);
dbApi.createMission('i-orphan', 'acme.coder', 'work', undefined, null);
dbApi.createMission('i-nogrant', 'acme.coder', 'work', undefined, ungranted.id);

const plugin = (id: string, state: PluginPublic['state'] = 'active') =>
  ({ id, state, kind: ['behavior'], source: 'bundled', route: null, slots: ['island.content'] }) as unknown as PluginPublic;
const ALL = () => [plugin('@timon/terminal-web'), plugin('@acme/board')];
let plugins: PluginPublic[] = ALL();
const late: Array<{ missionId: string; text: string }> = [];

type Fake = { kind: 'daemon-token' | 'session' | 'api-token'; userId?: string; missionId?: string | null };
const app = express();
app.use(express.json({ limit: '1mb' }));
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
registerIslandRoutes(app, { plugins: () => plugins });
registerLayoutProposalRoutes(app, { deliver: (missionId, text) => { late.push({ missionId, text }); } });
const server = createServer(app);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

const asOwner: Fake = { kind: 'session', userId: owner.id };
const asStranger: Fake = { kind: 'session', userId: stranger.id };
const asAgent: Fake = { kind: 'api-token', userId: owner.id, missionId: 'i-mission' };

async function call(method: string, path: string, who: Fake | null, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { 'x-test-auth': JSON.stringify(who) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

const snapshot = {
  types: [{
    type: '@timon/terminal-web:session',
    title: 'Terminal',
    params: {
      sessionId: { type: 'string', required: true, maxLength: 64 },
      scope: { type: 'string', nullable: true, maxLength: 128 },
    },
    volatileParams: ['sessionId'],
    singletonBy: 'sessionId',
  }],
};
const terminal = { type: '@timon/terminal-web:session', params: { sessionId: 's1', scope: null } };
const columns = {
  layout: { root: { dir: 'row', children: [{ tabs: [{ type: 'host:route' }] }, { tabs: [terminal] }], ratios: [2, 1] } },
  note: 'A terminal beside the page',
};

test('every route refuses an anonymous caller', async () => {
  for (const [method, path] of [['GET', '/api/islands'], ['PUT', '/api/islands/snapshot'], ['POST', '/api/islands/proposals']] as const) {
    const r = await call(method, path, null, method === 'GET' ? undefined : {});
    assert.equal(r.status, 401, `${method} ${path}`);
  }
});

test('the content types are published by a signed-in browser only', async () => {
  assert.equal((await call('PUT', '/api/islands/snapshot', asAgent, snapshot)).status, 403);
  assert.equal((await call('PUT', '/api/islands/snapshot', { kind: 'daemon-token', userId: owner.id }, snapshot)).status, 403);
  assert.equal((await call('PUT', '/api/islands/snapshot', asOwner, { catalog: [] })).status, 400);
  // One type out of bounds (a regex param) loses its own entry, not the others'.
  const mixed = await call('PUT', '/api/islands/snapshot', asOwner,
    { types: [{ type: '@acme/board:board', title: 'y', params: { a: { type: 'regex', pattern: '(a+)+' } } }, ...snapshot.types] });
  assert.deepEqual([mixed.status, mixed.json.kept, mixed.json.dropped], [200, 1, 1]);
  assert.ok(dbApi.uiLayoutGetOwn(owner.id, ISLAND_SNAPSHOT_SCOPE));
  assert.equal(dbApi.uiLayoutGetOwn(stranger.id, ISLAND_SNAPSHOT_SCOPE), undefined);
});

test('an agent reads its owner\'s workspace: the default tree, the types and their params', async () => {
  const r = await call('GET', '/api/islands', asAgent);
  assert.equal(r.status, 200);
  assert.equal(r.json.view, '/chat');
  assert.equal(r.json.customised, false);
  const types = r.json.types as Array<{ type: string; params: unknown }>;
  assert.deepEqual(types.map((t) => t.type), ['host:route', '@timon/terminal-web:session']);
  assert.deepEqual(Object.keys(types[1]!.params as object), ['sessionId', 'scope']);
  // The stranger has published nothing: their workspace is not the owner's.
  const theirs = await call('GET', '/api/islands', asStranger);
  assert.deepEqual((theirs.json.types as unknown[]).length, 1);
  assert.ok(theirs.json.warning);
});

test('a mission without an owner, or acting for another account, is refused', async () => {
  assert.equal((await call('GET', '/api/islands', { kind: 'api-token', missionId: 'i-orphan' })).status, 409);
  assert.equal((await call('GET', '/api/islands', { kind: 'api-token', userId: stranger.id, missionId: 'i-mission' })).status, 403);
  assert.equal((await call('POST', '/api/islands/proposals', { kind: 'api-token', userId: stranger.id, missionId: 'i-mission' }, columns)).status, 403);
});

let proposalId = '';

test('only an agent proposes; a valid layout becomes a card in its conversation', async () => {
  assert.equal((await call('POST', '/api/islands/proposals', asOwner, columns)).status, 403);
  assert.equal((await call('POST', '/api/islands/proposals', { kind: 'daemon-token', userId: owner.id }, columns)).status, 403);
  const r = await call('POST', '/api/islands/proposals', asAgent, columns);
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(r.json.status, 'pending');
  proposalId = r.json.id as string;
  const events = dbApi.listEvents('i-mission').filter((e) => e.type === LAYOUT_PROPOSAL_EVENT);
  assert.equal(events.length, 1);
  const row = dbApi.getLayoutProposal(proposalId)!;
  assert.equal(row.owner_user_id, owner.id);
  assert.equal(row.kind, 'islands');
  // Nothing on screen changed: the agent never writes the row itself.
  assert.equal(dbApi.uiLayoutGetOwn(owner.id, `${workspaceKey(owner.id, '/chat', null)}.islands`), undefined);
});

test('a proposal out of bounds, with bad params, or too large, is refused before any card', async () => {
  const bad = async (body: unknown) => {
    const r = await call('POST', '/api/islands/proposals', asAgent, body);
    return { status: r.status, codes: ((r.json.problems ?? []) as Array<{ code: string }>).map((p) => p.code) };
  };
  const noRoute = await bad({ layout: { root: { tabs: [terminal] } } });
  assert.deepEqual(noRoute, { status: 400, codes: ['route_tab'] });
  const missing = await bad({ open: { content: { type: '@timon/terminal-web:session', params: {} }, edge: 'right' } });
  assert.deepEqual(missing, { status: 400, codes: ['invalid_params'] });
  const extra = await bad({ open: { content: { type: '@timon/terminal-web:session', params: { sessionId: 's2', cmd: 'rm' } }, edge: 'right' } });
  assert.deepEqual(extra, { status: 400, codes: ['invalid_params'] });
  const nine = { dir: 'row', children: Array.from({ length: 8 }, () => ({ tabs: [terminal] })) };
  const tooMany = await bad({ layout: { root: { dir: 'column', children: [{ tabs: [{ type: 'host:route' }] }, nine] } } });
  assert.equal(tooMany.status, 400);
  assert.ok(tooMany.codes.includes('max_islands'));
  const deep = { dir: 'row', children: [{ tabs: [{ type: 'host:route' }] }, { dir: 'column', children: [{ tabs: [terminal] }, { dir: 'row', children: [{ tabs: [terminal] }, { dir: 'column', children: [{ tabs: [terminal] }, { tabs: [terminal] }] }] }] }] };
  assert.deepEqual(await bad({ layout: { root: deep } }), { status: 400, codes: ['max_depth'] });
  assert.equal((await bad({ layout: columns.layout, open: { content: terminal, edge: 'right' } })).status, 400);
  assert.equal((await bad({})).status, 400);
  assert.equal((await bad({ open: { content: terminal, edge: 'right', island: 'nothere' } })).codes[0], 'unknown_island');
  assert.equal((await bad({ open: { content: { type: 'host:route' }, edge: 'right' } })).codes[0], 'route_tab');
  const huge = await call('POST', '/api/islands/proposals', asAgent, { note: 'x', open: { content: { type: '@timon/terminal-web:session', params: { sessionId: 'x'.repeat(60 * 1024) } }, edge: 'right' } });
  assert.equal(huge.status, 413);
  let nested: unknown = { tabs: [terminal] };
  for (let i = 0; i < 200; i++) nested = { dir: 'row', children: [nested, { tabs: [terminal] }] };
  assert.equal((await bad({ layout: { root: nested } })).status, 400, 'a deeply nested body is refused before zod recurses');
});

test('a type of a plugin the owner was not granted, or unknown to the daemon, is refused', async () => {
  dbApi.uiLayoutSet(ungranted.id, ISLAND_SNAPSHOT_SCOPE, dbApi.uiLayoutGetOwn(owner.id, ISLAND_SNAPSHOT_SCOPE)!.value);
  const r = await call('POST', '/api/islands/proposals', { kind: 'api-token', userId: ungranted.id, missionId: 'i-nogrant' },
    { open: { content: terminal, edge: 'right' } });
  assert.equal(r.status, 400);
  assert.equal((r.json.problems as Array<{ code: string }>)[0]?.code, 'unknown_type');
  const ghost = await call('POST', '/api/islands/proposals', asAgent, { open: { content: { type: '@evil/ghost:x' }, edge: 'right' } });
  assert.equal((ghost.json.problems as Array<{ code: string }>)[0]?.code, 'unknown_type');
  // A granted plugin whose browser half has not registered yet: waiting content, with a warning.
  const waiting = await call('POST', '/api/islands/proposals', asAgent, { open: { content: { type: '@acme/board:board', params: { id: 'q3' } }, edge: 'center' } });
  assert.equal(waiting.status, 202);
  assert.equal((waiting.json.warnings as string[]).length, 1);
  assert.equal((await call('POST', `/api/layout/proposals/${waiting.json.id as string}/resolve`, asOwner, { decision: 'dismissed' })).status, 200);
});

test('another account neither lists nor answers the proposal', async () => {
  const list = await call('GET', '/api/layout/proposals?mission_id=i-mission', asStranger);
  assert.deepEqual(list.json.proposals, []);
  assert.equal((await call('POST', `/api/layout/proposals/${proposalId}/resolve`, asStranger, { decision: 'applied' })).status, 404);
  assert.equal((await call('POST', `/api/layout/proposals/${proposalId}/resolve`, asAgent, { decision: 'applied' })).status, 403);
  assert.equal(dbApi.getLayoutProposal(proposalId)?.status, 'pending');
});

test('a grant withdrawn before the click makes the proposal stale; the owner then applies it once', async () => {
  plugins = [plugin('@timon/terminal-web', 'disabled'), plugin('@acme/board')];
  try {
    const r = await call('POST', `/api/layout/proposals/${proposalId}/resolve`, asOwner, { decision: 'applied' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'stale');
  } finally {
    plugins = ALL();
  }
  const ok = await call('POST', `/api/layout/proposals/${proposalId}/resolve`, asOwner, { decision: 'applied' });
  assert.equal(ok.status, 200);
  assert.match(late.at(-1)?.text ?? '', /applied your island layout/);
});

test('an island closed before the click makes an `open` proposal stale', async () => {
  const scope = `${workspaceKey(owner.id, '/chat', null)}.islands`;
  const stored = {
    v: 1,
    focus: 'leafa',
    root: { id: 'splt', kind: 'split', dir: 'row', ratios: [0.5, 0.5], children: [
      { id: 'leafa', kind: 'leaf', active: 'taba', tabs: [{ id: 'taba', content: { type: 'host:route', params: {} } }] },
      { id: 'leafb', kind: 'leaf', active: 'tabb', tabs: [{ id: 'tabb', content: terminal }] },
    ] },
  };
  dbApi.uiLayoutSet(owner.id, scope, JSON.stringify(stored));
  const read = await call('GET', '/api/islands', asAgent);
  assert.equal(read.json.customised, true);
  assert.equal(read.json.islands, 2);
  const r = await call('POST', '/api/islands/proposals', asAgent,
    { open: { content: { type: '@timon/terminal-web:session', params: { sessionId: 's9' } }, edge: 'center', island: 'leafb' } });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  dbApi.uiLayoutSet(owner.id, scope, JSON.stringify({ ...stored, root: stored.root.children[0] }));
  const stale = await call('POST', `/api/layout/proposals/${r.json.id as string}/resolve`, asOwner, { decision: 'applied' });
  assert.equal(stale.status, 409);
  assert.equal((stale.json.problems as Array<{ code: string }>)[0]?.code, 'unknown_island');
});

test('the widget columns of the same card are checked like a widgets proposal', async () => {
  const before = dbApi.listEvents('i-mission').filter((e) => e.type === LAYOUT_PROPOSAL_EVENT).length;
  const empty = await call('POST', '/api/islands/proposals', asAgent, { ...columns, widgets: {} });
  assert.equal(empty.json.error, 'invalid_proposal');
  assert.ok((empty.json.problems as Array<{ code: string }>).some((p) => p.code === 'empty_widgets'));
  // No widget catalog published by the owner's browser: nothing can be placed, so the whole card is refused.
  const unknown = await call('POST', '/api/islands/proposals', asAgent,
    { ...columns, widgets: { zones: { 'chat.left.widget': ['plugin:@evil/ghost:x'] } } });
  assert.notEqual(unknown.status, 202);
  assert.equal(unknown.json.error, 'invalid_proposal');
  assert.equal(dbApi.listEvents('i-mission').filter((e) => e.type === LAYOUT_PROPOSAL_EVENT).length, before, 'no card');
});

test('also_projects: one card sets up other projects of the view, with a whole layout only', async () => {
  const r = await call('POST', '/api/islands/proposals', asAgent, { ...columns, also_projects: [''] });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.deepEqual((JSON.parse(dbApi.getLayoutProposal(r.json.id as string)!.payload) as { also_projects?: string[] }).also_projects, ['']);
  const open = await call('POST', '/api/islands/proposals', asAgent,
    { view: '/chat', open: { content: { type: 'host:route' }, edge: 'right' }, also_projects: [''] });
  assert.equal(open.status, 400);
  const bad = await call('POST', '/api/islands/proposals', asAgent, { ...columns, also_projects: ['../etc'] });
  assert.equal(bad.status, 400);
});
