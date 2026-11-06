/**
 * `islands_arrangements_list` / `islands_arrangement_save` as the daemon
 * serves them. The refusals matter most: an anonymous caller, another account
 * reading the list, the operator's CLI writing it, a layout the card would
 * refuse. Then what lands in the row: no day's state, never in the menu, and
 * a version that moves so the browser's menu sees the conflict.
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
const { registerRoutes } = await import('./routes.js');
const { registerLayoutProposalRoutes } = await import('./layout-proposals.js');
const { workspaceKey } = await import('./widget-model.js');
const { readArrangements } = await import('./island-arrangements.js');
const { dbApi } = await import('../../db.js');

const owner = createTestAccount(dbApi, { email: 'a-owner@example.com', name: 'owner', passwordHash: 'x', isSuperadmin: true });
const stranger = createTestAccount(dbApi, { email: 'a-stranger@example.com', name: 'stranger', passwordHash: 'x', isSuperadmin: true });
dbApi.createMission('a-mission', 'acme.coder', 'keep my islands', undefined, owner.id);
dbApi.createMission('a-stranger', 'acme.coder', 'work', undefined, stranger.id);

const plugin = (id: string) =>
  ({ id, state: 'active', kind: ['behavior'], source: 'bundled', route: null, slots: ['island.content'] }) as unknown as PluginPublic;
const plugins = [plugin('@timon/terminal-web'), plugin('@acme/board')];

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
registerRoutes(app);
const delivered: string[] = [];
registerLayoutProposalRoutes(app, { deliver: (_mission, text) => { delivered.push(text); } });
const server = createServer(app);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

const asOwner: Fake = { kind: 'session', userId: owner.id };
const asStranger: Fake = { kind: 'session', userId: stranger.id };
const asAgent: Fake = { kind: 'api-token', userId: owner.id, missionId: 'a-mission' };
const asStrangerAgent: Fake = { kind: 'api-token', userId: stranger.id, missionId: 'a-stranger' };
const asCli: Fake = { kind: 'daemon-token', userId: owner.id };

async function call(method: string, path: string, who: Fake | null, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { 'x-test-auth': JSON.stringify(who) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

const TERMINAL = '@timon/terminal-web:session';
const snapshot = {
  types: [{
    type: TERMINAL,
    title: 'Terminal',
    params: {
      sessionId: { type: 'string', maxLength: 64 },
      scope: { type: 'string', nullable: true, maxLength: 128 },
      fresh: { type: 'boolean' },
    },
    volatileParams: ['sessionId'],
    singletonBy: 'sessionId',
  }],
};
const chatRow = `${workspaceKey(owner.id, '/chat', null)}.islands`;
const screen = {
  v: 1,
  focus: 'leafa',
  root: { id: 'splt', kind: 'split', dir: 'row', ratios: [0.6, 0.4], children: [
    { id: 'leafa', kind: 'leaf', active: 'taba', tabs: [{ id: 'taba', content: { type: 'host:route', params: {} } }] },
    { id: 'leafb', kind: 'leaf', active: 'tabb', tabs: [{ id: 'tabb', content: { type: TERMINAL, params: { sessionId: 'live-shell', scope: 'project:x' } } }] },
  ] },
};
const arrangementsRow = (user: string) => `${workspaceKey(user, '', null)}.arrangements`;
const storedList = (user: string) => readArrangements(JSON.parse(dbApi.uiLayoutGetOwn(user, arrangementsRow(user))?.value ?? 'null'));

test('both routes refuse an anonymous caller', async () => {
  assert.equal((await call('GET', '/api/islands/arrangements', null)).status, 401);
  assert.equal((await call('POST', '/api/islands/arrangements', null, { name: 'x' })).status, 401);
});

test('setup: the owner\'s browser published its types, and the chat holds two islands', async () => {
  assert.equal((await call('PUT', '/api/islands/snapshot', asOwner, snapshot)).status, 200);
  dbApi.uiLayoutSet(owner.id, chatRow, JSON.stringify(screen));
});

test('a view showing its page alone has nothing to keep', async () => {
  const r = await call('POST', '/api/islands/arrangements', asAgent, { name: 'Empty', view: '/kanban' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'empty-tree');
  assert.deepEqual(storedList(owner.id), []);
});

let savedId = '';

test('an agent keeps its own chat\'s islands, without the shell, out of the menu, screen untouched', async () => {
  const r = await call('POST', '/api/islands/arrangements', asAgent, { name: 'Code' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.from, { view: '/chat', project: null });
  const arrangement = r.json.arrangement as { id: string; href: string; menu: boolean; summary: { islands: number; contents: unknown } };
  savedId = arrangement.id;
  assert.equal(arrangement.href, `/islands/${savedId}`);
  assert.equal(arrangement.menu, false);
  assert.equal(arrangement.summary.islands, 2);
  assert.deepEqual(arrangement.summary.contents, [{ type: TERMINAL, title: 'Terminal' }]);
  const [stored] = storedList(owner.id);
  assert.equal(stored!.id, savedId);
  assert.equal(stored!.menu, false);
  const tree = JSON.stringify(stored!.tree);
  assert.ok(!tree.includes('live-shell'), 'the day\'s shell never enters an arrangement');
  assert.ok(tree.includes('project:x'), 'what is not volatile is kept');
  assert.deepEqual(JSON.parse(dbApi.uiLayoutGetOwn(owner.id, chatRow)!.value), screen, 'nothing changed on screen');
});

test('the list: summaries by default, trees on demand; the operator\'s CLI may read it', async () => {
  const r = await call('GET', '/api/islands/arrangements', asAgent);
  assert.equal(r.status, 200);
  const [first] = r.json.arrangements as Array<Record<string, unknown>>;
  assert.equal(first!.id, savedId);
  assert.equal(first!.name, 'Code');
  assert.equal(first!.tree, undefined);
  assert.deepEqual(r.json.limits, { arrangements: 12, nameLength: 40 });
  assert.equal(typeof r.json.updatedAt, 'number');
  const full = await call('GET', '/api/islands/arrangements?full=1', asAgent);
  const tree = (full.json.arrangements as Array<{ tree: { dir: string; children: unknown[] } }>)[0]!.tree;
  assert.equal(tree.dir, 'row');
  assert.equal(tree.children.length, 2);
  assert.equal((await call('GET', '/api/islands/arrangements?full=yes', asAgent)).status, 400);
  assert.equal((await call('GET', '/api/islands/arrangements', asCli)).status, 200);
  assert.equal((await call('POST', '/api/islands/arrangements', asCli, { name: 'CLI' })).status, 403, 'the daemon token names no account to write for');
});

test('another account never sees the list, and writes only its own', async () => {
  assert.deepEqual((await call('GET', '/api/islands/arrangements', asStranger)).json.arrangements, []);
  assert.deepEqual((await call('GET', '/api/islands/arrangements', asStrangerAgent)).json.arrangements, []);
  // A mission acting for another account than its owner's is refused.
  assert.equal((await call('GET', '/api/islands/arrangements', { kind: 'api-token', userId: stranger.id, missionId: 'a-mission' })).status, 403);
  // Its own chat shows its page alone: nothing to keep, and nothing lands in the owner's list.
  assert.equal((await call('POST', '/api/islands/arrangements', asStrangerAgent, { name: 'Code', replace: true })).json.error, 'empty-tree');
  assert.equal(storedList(owner.id).length, 1);
  assert.deepEqual(storedList(stranger.id), []);
});

test('a name already kept is refused, unless replace: same id, same page, menu entry kept', async () => {
  const twin = await call('POST', '/api/islands/arrangements', asAgent, { name: 'code' });
  assert.equal(twin.status, 409);
  assert.equal(twin.json.error, 'duplicate-name');
  // The user put it in the menu meanwhile.
  const scope = arrangementsRow(owner.id);
  const list = storedList(owner.id).map((a) => ({ ...a, menu: true }));
  dbApi.uiLayoutSet(owner.id, scope, JSON.stringify({ v: 1, arrangements: list }));
  const r = await call('POST', '/api/islands/arrangements', asAgent, { name: 'code', replace: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.replaced, true);
  const after = storedList(owner.id);
  assert.equal(after.length, 1);
  assert.deepEqual([after[0]!.id, after[0]!.name, after[0]!.menu], [savedId, 'Code', true]);
});

test('a layout is checked like a proposal, then stored without its day\'s state', async () => {
  const layout = { root: { dir: 'column', children: [
    { tabs: [{ type: 'host:route' }] },
    { tabs: [{ type: TERMINAL, params: { sessionId: 'sess-9', scope: null } }] },
  ] } };
  const ok = await call('POST', '/api/islands/arrangements', asAgent, { name: 'Stacked', layout });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(ok.json.from, { layout: true });
  const stored = storedList(owner.id).find((a) => a.name === 'Stacked')!;
  assert.equal((stored.tree.root as { dir: string }).dir, 'column');
  assert.ok(!JSON.stringify(stored.tree).includes('sess-9'));

  const refused = async (body: unknown) => {
    const r = await call('POST', '/api/islands/arrangements', asAgent, body);
    return { status: r.status, error: r.json.error, codes: ((r.json.problems ?? []) as Array<{ code: string }>).map((p) => p.code) };
  };
  assert.deepEqual(await refused({ name: 'NoPage', layout: { root: { tabs: [{ type: TERMINAL }] } } }), { status: 400, error: 'invalid_layout', codes: ['route_tab'] });
  const ghost = await refused({ name: 'Ghost', layout: { root: { dir: 'row', children: [{ tabs: [{ type: 'host:route' }] }, { tabs: [{ type: '@evil/ghost:x' }] }] } } });
  assert.deepEqual(ghost.codes, ['unknown_type']);
  assert.equal((await refused({ name: 'Both', view: '/chat', layout })).status, 400);
  assert.equal((await refused({ name: 'Bad', layout: { root: 'nope' } })).status, 400);
  assert.equal((await refused({ name: 'Extra', layout, menu: true })).status, 400, 'an agent never puts an arrangement in the menu');
  assert.equal((await refused({ layout })).status, 400);
  // Without the owner's types, a layout cannot be checked.
  const blind = await call('POST', '/api/islands/arrangements', asStrangerAgent, { name: 'Blind', layout });
  assert.deepEqual([blind.status, blind.json.error], [409, 'invalid_layout']);
  const huge = await call('POST', '/api/islands/arrangements', asAgent, { name: 'Huge', layout: { root: { tabs: [{ type: 'host:route' }] }, pad: 'x'.repeat(60 * 1024) } });
  assert.equal(huge.status, 413);
  assert.equal(storedList(owner.id).length, 2);
});

test('twelve at most per account', async () => {
  const scope = arrangementsRow(owner.id);
  const tree = storedList(owner.id)[0]!.tree;
  const full = Array.from({ length: 12 }, (_, i) => ({ id: `full-${i}`, name: `n${i}`, createdAt: 0, tree, menu: false }));
  const before = dbApi.uiLayoutGetOwn(owner.id, scope)!.value;
  dbApi.uiLayoutSet(owner.id, scope, JSON.stringify({ v: 1, arrangements: full }));
  try {
    const r = await call('POST', '/api/islands/arrangements', asAgent, { name: 'Thirteenth' });
    assert.deepEqual([r.status, r.json.error], [409, 'too-many']);
  } finally {
    dbApi.uiLayoutSet(owner.id, scope, before);
  }
});

test('a recall card: anonymous and browser refused, the id must be the owner\'s own', async () => {
  assert.equal((await call('POST', '/api/islands/proposals', null, { arrangement: savedId })).status, 401);
  assert.equal((await call('POST', '/api/islands/proposals', asOwner, { arrangement: savedId })).status, 403, 'a card is raised by an agent');
  const before = dbApi.listLayoutProposals({ ownerUserId: stranger.id }).length;
  const theirs = await call('POST', '/api/islands/proposals', asStrangerAgent, { arrangement: savedId });
  const absent = await call('POST', '/api/islands/proposals', asStrangerAgent, { arrangement: 'no-such-id' });
  assert.equal(theirs.status, 404);
  assert.equal(theirs.json.error, 'unknown_arrangement');
  // Another account's id answers exactly as an id that exists nowhere: nothing of it leaks.
  assert.deepEqual(JSON.parse(JSON.stringify(theirs.json).replaceAll(savedId, 'X')), JSON.parse(JSON.stringify(absent.json).replaceAll('no-such-id', 'X')));
  assert.ok(!JSON.stringify(theirs.json).includes('Code'), 'the name of the owner\'s arrangement never reaches another account');
  assert.equal(dbApi.listLayoutProposals({ ownerUserId: stranger.id }).length, before, 'no card raised');
});

test('a recall card goes alone: no layout, open, widgets nor also_projects with it', async () => {
  const layout = { root: { tabs: [{ type: 'host:route' }] } };
  for (const extra of [
    { layout },
    { open: { content: { type: TERMINAL }, edge: 'right' } },
    { widgets: { zones: {} } },
    { also_projects: [''] },
    { menu: true },
  ]) {
    const r = await call('POST', '/api/islands/proposals', asAgent, { arrangement: savedId, ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.equal(r.json.error, 'invalid_request');
  }
  assert.equal((await call('POST', '/api/islands/proposals', asAgent, { arrangement: '../x' })).status, 400);
});

test('a recall card names the arrangement and its view, and changes nothing until Apply', async () => {
  const chatBefore = dbApi.uiLayoutGetOwn(owner.id, chatRow)!.value;
  const r = await call('POST', '/api/islands/proposals', asAgent, { arrangement: savedId, view: '/kanban', note: 'your code screen' });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(r.json.status, 'pending');
  assert.deepEqual(r.json.proposal, { arrangement: savedId, name: 'Code', view: '/kanban', project: null });
  assert.equal((r.json.arrangement as { summary: { islands: number } }).summary.islands, 2);
  const row = dbApi.getLayoutProposal(r.json.id as string)!;
  assert.equal(row.kind, 'island-arrangement');
  assert.equal(row.note, 'your code screen');
  // Default view: the mission's own chat.
  const own = await call('POST', '/api/islands/proposals', asAgent, { arrangement: savedId });
  assert.deepEqual(own.json.proposal, { arrangement: savedId, name: 'Code', view: '/chat', project: null });
  assert.equal(dbApi.uiLayoutGetOwn(owner.id, chatRow)!.value, chatBefore, 'nothing changed on screen');
  assert.equal(dbApi.uiLayoutGetOwn(owner.id, `${workspaceKey(owner.id, '/kanban', null)}.islands`), undefined);
  const applied = await call('POST', `/api/layout/proposals/${own.json.id as string}/resolve`, asOwner, { decision: 'applied' });
  assert.equal(applied.status, 200, JSON.stringify(applied.json));
  assert.match(delivered.at(-1) ?? '', /applied your island arrangement/);
});

test('an arrangement deleted between the proposal and the click: the claim is refused, the card stays pending', async () => {
  const r = await call('POST', '/api/islands/proposals', asAgent, { arrangement: savedId });
  assert.equal(r.status, 202);
  const scope = arrangementsRow(owner.id);
  const before = dbApi.uiLayoutGetOwn(owner.id, scope)!.value;
  dbApi.uiLayoutSet(owner.id, scope, JSON.stringify({ v: 1, arrangements: storedList(owner.id).filter((a) => a.id !== savedId) }));
  try {
    const claim = await call('POST', `/api/layout/proposals/${r.json.id as string}/resolve`, asOwner, { decision: 'applied' });
    assert.equal(claim.status, 409);
    assert.equal(claim.json.error, 'stale');
    assert.deepEqual((claim.json.problems as Array<{ code: string; message: string }>).map((p) => p.code), ['arrangement_deleted']);
    assert.match((claim.json.problems as Array<{ message: string }>)[0]!.message, /"Code" was deleted/);
    assert.equal(dbApi.getLayoutProposal(r.json.id as string)!.status, 'pending');
    // Ignoring it still works.
    assert.equal((await call('POST', `/api/layout/proposals/${r.json.id as string}/resolve`, asOwner, { decision: 'dismissed' })).status, 200);
  } finally {
    dbApi.uiLayoutSet(owner.id, scope, before);
  }
});

test('the write moves the row\'s version: a menu that read before it is refused and reads again', async () => {
  const scope = encodeURIComponent(arrangementsRow(owner.id));
  const read = await call('GET', `/api/layout?scope=${scope}`, asOwner);
  const seen = read.json.updatedAt as number;
  const saved = await call('POST', '/api/islands/arrangements', asAgent, { name: 'Code', replace: true });
  assert.equal(saved.status, 200);
  assert.ok((saved.json.updatedAt as number) > seen);
  const layout = { v: 1, arrangements: [] };
  const stale = await call('PUT', `/api/layout?scope=${scope}&expected=${seen}`, asOwner, { layout });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'conflict');
  assert.equal(storedList(owner.id).length, 2, 'the agent\'s write survived');
  const fresh = await call('PUT', `/api/layout?scope=${scope}&expected=${saved.json.updatedAt as number}`, asOwner, { layout });
  assert.equal(fresh.status, 200);
});
