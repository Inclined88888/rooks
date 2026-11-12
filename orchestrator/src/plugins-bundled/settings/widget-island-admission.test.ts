/**
 * The widget island contents are admitted by the daemon as the real bundled
 * module list sees them: a client-only module (`@rooks/ui-layout`) must be a
 * plugin the owner may use, or `islands_get` would never list them and
 * `islands_propose` would refuse them — and the onboarding skill with them.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { galleryPlugins } from '../../plugins/runtime.js';

await import('../../../tests/helpers/paid-license.js');
const { registerIslandRoutes } = await import('./island-routes.js');
const { dbApi } = await import('../../db.js');

const owner = createTestAccount(dbApi, { email: 'w-owner@example.com', name: 'owner', passwordHash: 'x', isSuperadmin: true });
dbApi.createMission('w-mission', 'acme.coder', 'make me a page', undefined, owner.id);

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const raw = req.header('x-test-auth');
  if (raw) {
    const f = JSON.parse(raw) as { kind: 'session' | 'api-token'; missionId?: string };
    req.auth = {
      kind: f.kind, user: dbApi.getUserById(owner.id) ?? null, isSuperadmin: true,
      missionId: f.missionId ?? null, ...(f.kind === 'api-token' ? { permissions: [] } : {}),
    };
  }
  next();
});
// The real bundled rows, no third-party loader.
registerIslandRoutes(app, { plugins: () => galleryPlugins(null) });
const server = createServer(app);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

const asOwner = { kind: 'session' };
const asAgent = { kind: 'api-token', missionId: 'w-mission' };
async function call(method: string, path: string, who: object, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-auth': JSON.stringify(who) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

const snapshot = {
  types: [
    { type: '@rooks/ui-layout:widget-card', title: 'Widget', params: { widget: { type: 'string', required: true, maxLength: 200 } }, singletonBy: 'widget' },
    { type: '@rooks/ui-layout:widget-zone', title: 'Widgets', params: {} },
  ],
};

test('an agent sees both widget contents and can propose them', async () => {
  assert.equal((await call('PUT', '/api/islands/snapshot', asOwner, snapshot)).status, 200);
  const got = await call('GET', '/api/islands', asAgent);
  const types = (got.json.types as Array<{ type: string }>).map((t) => t.type);
  assert.ok(types.includes('@rooks/ui-layout:widget-card'), 'widget-card listed');
  assert.ok(types.includes('@rooks/ui-layout:widget-zone'), 'widget-zone listed');

  const card = await call('POST', '/api/islands/proposals', asAgent, {
    view: '/', open: { content: { type: '@rooks/ui-layout:widget-card', params: { widget: 'plugin:@rooks/missions:Missions' } }, edge: 'right' },
  });
  assert.equal(card.status, 202, JSON.stringify(card.json));
  const zone = await call('POST', '/api/islands/proposals', asAgent, {
    view: '/', open: { content: { type: '@rooks/ui-layout:widget-zone' }, edge: 'bottom' },
  });
  assert.equal(zone.status, 202, JSON.stringify(zone.json));
});
