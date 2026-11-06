/**
 * `GET /api/missions/latest?agent=` — what a chat opened without `?mission=`
 * binds, without waiting for the 300-row list.
 *
 * What we protect: the same pick as the chat made from the list (recency of
 * the last event, running first, setup excluded), the same owner scope as the
 * list, and an explicit refusal of an anonymous caller.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { RequestAuth } from './users/identity.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-mission-latest-test-'));

const { db, dbApi } = await import('./db.js');
const { registerRoutes, pickLatestMission } = await import('./plugins-bundled/missions/routes.js');

const setStarted = db.prepare(`UPDATE missions SET started_at = ?, source_channel = ? WHERE id = ?`);
const addEvent = db.prepare(`INSERT INTO events (mission_id, type, timestamp, payload) VALUES (?, 'assistant', ?, '{}')`);

function mission(agent: string, owner: string | null, startedAt: number, lastEventAt: number | null, channel: string | null = null): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'brief', undefined, owner);
  setStarted.run(startedAt, channel, id);
  if (lastEventAt !== null) addEvent.run(id, lastEventAt);
  return id;
}

async function call(path: string, auth: RequestAuth | null): Promise<{ status: number; body: { mission?: { id: string } | null; error?: string } }> {
  const app = express();
  app.use((req, _res, next) => {
    if (auth) req.auth = auth;
    next();
  });
  registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: r.status, body: await r.json() as { mission?: { id: string } | null; error?: string } };
  } finally {
    server.close();
  }
}

const ROOT: RequestAuth = { kind: 'api-token', user: null, isSuperadmin: true, permissions: ['*'] };
const asUser = (id: string): RequestAuth => ({ kind: 'api-token', user: null, isSuperadmin: false, actorId: id, permissions: ['missions:read'] });

// Started order ≠ activity order: the latest is the one spoken to last.
const old = mission('eta.main', 'user-a', 1_000, 90_000);
const recent = mission('eta.main', 'user-a', 5_000, 10_000);
const setup = mission('eta.main', 'user-a', 6_000, 99_000, 'setup');
const silent = mission('eta.main', 'user-b', 4_000, null);
mission('theta.main', 'user-a', 9_000, 999_000);

test('an anonymous caller is refused', async () => {
  const r = await call('/api/missions/latest?agent=eta.main', null);
  assert.equal(r.status, 401);
  assert.equal(r.body.mission, undefined);
});

test('the agent is required', async () => {
  assert.equal((await call('/api/missions/latest', ROOT)).status, 400);
  assert.equal((await call('/api/missions/latest?agent=', ROOT)).status, 400);
});

test('the pick is the latest activity, setup conversations excluded, other agents ignored', async () => {
  const r = await call('/api/missions/latest?agent=eta.main', ROOT);
  assert.equal(r.status, 200);
  assert.equal(r.body.mission?.id, old);
  assert.notEqual(r.body.mission?.id, setup);
});

test("same owner scope as the list: a viewer never gets another account's mission", async () => {
  const a = await call('/api/missions/latest?agent=eta.main', asUser('user-a'));
  assert.equal(a.body.mission?.id, old);
  const b = await call('/api/missions/latest?agent=eta.main', asUser('user-b'));
  assert.equal(b.body.mission?.id, silent);
  const listed = dbApi.listMissions(300, ['eta.main'], undefined, { id: 'user-b', isSuperadmin: false }).map((m) => m.id);
  assert.deepEqual(listed, [silent]);
  const none = await call('/api/missions/latest?agent=eta.main', asUser('user-c'));
  assert.equal(none.status, 200);
  assert.equal(none.body.mission, null);
});

test('a mission not backfilled yet is dated by its events, like the list', async () => {
  db.prepare(`DELETE FROM mission_stats WHERE mission_id = ?`).run(recent);
  addEvent.run(recent, 500_000);
  const r = await call('/api/missions/latest?agent=eta.main', ROOT);
  assert.equal(r.body.mission?.id, recent);
});

test('a running mission wins over a more recent idle one', () => {
  const rows = [{ id: 'idle-recent' }, { id: 'running-older' }, { id: 'running-oldest' }];
  assert.equal(pickLatestMission(rows, (id) => id.startsWith('running'))?.id, 'running-older');
  assert.equal(pickLatestMission(rows, () => false)?.id, 'idle-recent');
  assert.equal(pickLatestMission([], () => true), undefined);
});
