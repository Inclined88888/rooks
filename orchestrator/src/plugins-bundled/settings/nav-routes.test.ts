/**
 * The side menu an agent proposes to its owner. The refusals matter most: an
 * anonymous caller, a browser proposing, a path that is not a view, another
 * account answering the card.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

await import('../../../tests/helpers/paid-license.js');
const { registerNavRoutes } = await import('./nav-routes.js');
const { sharedNavKey } = await import('./nav-model.js');
const { registerLayoutProposalRoutes } = await import('./layout-proposals.js');
const { dbApi } = await import('../../db.js');

const owner = createTestAccount(dbApi, { email: 'nav-owner@example.com', name: 'owner', passwordHash: 'x', isSuperadmin: true });
const stranger = createTestAccount(dbApi, { email: 'nav-stranger@example.com', name: 'stranger', passwordHash: 'x', isSuperadmin: true });
dbApi.createMission('nav-mission', 'acme.coder', 'tidy my menu', undefined, owner.id);

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
registerNavRoutes(app);
registerLayoutProposalRoutes(app, { deliver: (missionId, text) => { late.push({ missionId, text }); } });
const server = createServer(app);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

const asOwner: Fake = { kind: 'session', userId: owner.id };
const asStranger: Fake = { kind: 'session', userId: stranger.id };
const asAgent: Fake = { kind: 'api-token', userId: owner.id, missionId: 'nav-mission' };

async function call(method: string, path: string, who: Fake | null, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { 'x-test-auth': JSON.stringify(who) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

test('every route refuses an anonymous caller', async () => {
  assert.equal((await call('GET', '/api/nav', null)).status, 401);
  assert.equal((await call('POST', '/api/nav/proposals', null, { hidden: ['/kanban'] })).status, 401);
});

test('a browser cannot propose: a proposal is raised by an agent mission', async () => {
  assert.equal((await call('POST', '/api/nav/proposals', asOwner, { hidden: ['/kanban'] })).status, 403);
});

test('a path that is not a view, a duplicate or an extra field is refused', async () => {
  for (const hidden of [['//evil.example'], ['/a?b=c'], ['javascript:x'], ['/kanban', '/kanban']]) {
    assert.equal((await call('POST', '/api/nav/proposals', asAgent, { hidden })).status, 400, JSON.stringify(hidden));
  }
  assert.equal((await call('POST', '/api/nav/proposals', asAgent, { hidden: [], pinned: true })).status, 400);
});

test('the hidden pages are read from the owner\'s menu row, with the product\'s entries', async () => {
  dbApi.uiLayoutSet(owner.id, sharedNavKey(owner.id), JSON.stringify({ pinned: true, hidden: ['/terminal'] }));
  const r = await call('GET', '/api/nav', asAgent);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.hidden, ['/terminal']);
  assert.ok((r.json.pages as Array<{ path: string }>).some((p) => p.path === '/kanban'));
  assert.deepEqual((await call('GET', '/api/nav', asStranger)).json.hidden, []);
});

test('a proposal becomes a pending card its owner alone answers', async () => {
  const r = await call('POST', '/api/nav/proposals', asAgent, { hidden: ['/kanban', '/terminal'], note: 'a calmer menu' });
  assert.equal(r.status, 202);
  assert.equal(r.json.status, 'pending');
  const id = r.json.id as string;
  assert.equal((await call('POST', `/api/layout/proposals/${id}/resolve`, asStranger, { decision: 'applied' })).status, 404);
  assert.equal((await call('POST', `/api/layout/proposals/${id}/resolve`, asAgent, { decision: 'applied' })).status, 403);
  assert.equal((await call('POST', `/api/layout/proposals/${id}/resolve`, asOwner, { decision: 'applied' })).status, 200);
  assert.match(late.at(-1)?.text ?? '', /menu/);
});

test('a page the product does not list is accepted with a warning', async () => {
  const r = await call('POST', '/api/nav/proposals', asAgent, { hidden: ['/acme'] });
  assert.equal(r.status, 202);
  assert.ok(Array.isArray(r.json.warnings));
});

test('the layout of the menu is read from the row: main list, foot, separators; null when never laid out', async () => {
  dbApi.uiLayoutSet(owner.id, sharedNavKey(owner.id), JSON.stringify({ hidden: [], order: ['/', '---', '/acme'], footer: ['/plugins'] }));
  const r = await call('GET', '/api/nav', asAgent);
  assert.deepEqual([r.json.order, r.json.footer, r.json.separator], [['/', '---', '/acme'], ['/plugins'], '---']);
  dbApi.uiLayoutSet(owner.id, sharedNavKey(owner.id), JSON.stringify({ pinned: true }));
  const never = await call('GET', '/api/nav', asAgent);
  assert.deepEqual([never.json.order, never.json.footer], [null, null]);
});

test('a proposal may lay out the menu: order, separators and foot, without touching the hidden pages', async () => {
  const r = await call('POST', '/api/nav/proposals', asAgent, { order: ['/', '/agents', '---', '/kanban'], footer: ['/plugins', '---', '/acme'] });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.deepEqual(r.json.proposal, { order: ['/', '/agents', '---', '/kanban'], footer: ['/plugins', '---', '/acme'] });
  assert.ok((r.json.warnings as string[]).some((w) => w.includes('/acme')), 'a plugin page is accepted with a warning');
});

test('an empty proposal, a page placed twice or a separator that is not "---" is refused', async () => {
  for (const body of [{}, { note: 'nothing' }, { order: ['/kanban'], footer: ['/kanban'] }, { order: ['/a', '/a'] }, { order: ['--'] }, { footer: ['___'] }]) {
    assert.equal((await call('POST', '/api/nav/proposals', asAgent, body)).status, 400, JSON.stringify(body));
  }
});
