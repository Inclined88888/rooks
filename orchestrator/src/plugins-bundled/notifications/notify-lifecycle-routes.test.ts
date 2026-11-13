/**
 * SUG-0048 through the real route: an agent's action_required carries its
 * lifecycle, a malformed one is refused before the database, and an anonymous
 * caller never gets that far.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-notify-lifecycle-'));
await import('../../../tests/helpers/paid-license.js');

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');

const TOKEN = 'witness-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

async function post(body: unknown, bearer: string | null = TOKEN): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/notifications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const mission = randomUUID();
dbApi.createMission(mission, 'rooks.coder', 'notify');

test('an anonymous caller is refused', async () => {
  const r = await post({ type: 'action_required', title: 'x', mission_id: mission }, null);
  assert.equal(r.status, 401);
});

test('an agent card is stored with its lifecycle', async () => {
  const r = await post({ type: 'action_required', title: 'Renew the token', mission_id: mission });
  assert.equal(r.status, 201);
  const id = (r.json.notification as { id: string }).id;
  const row = dbApi.getNotification(id)!;
  assert.equal(row.dismiss_on, '["reply"]');
  assert.ok(row.expires_at && row.expires_at > Date.now() + 6 * 24 * 3_600_000, 'the 7-day backstop');

  const ttl = await post({ type: 'action_required', title: 'Look at it', ttl_minutes: 10 });
  assert.equal(ttl.status, 201);
  const lapsing = dbApi.getNotification((ttl.json.notification as { id: string }).id)!;
  assert.equal(lapsing.dismiss_on, null);
  assert.ok(lapsing.expires_at && lapsing.expires_at > Date.now());
});

test('a malformed lifecycle is a 400 and stores nothing', async () => {
  const before = dbApi.listActiveNotifications().length;
  for (const body of [
    { type: 'action_required', title: 'x', mission_id: mission, dismiss_on: ['whenever'] },
    { type: 'action_required', title: 'x', mission_id: mission, dismiss_on: 'reply' },
    { type: 'action_required', title: 'x', ttl_minutes: -1 },
    { type: 'action_required', title: 'x', ttl_minutes: 60 * 24 * 365 },
    { type: 'action_required', title: 'x', dismiss_on: ['task_done'] },
    { type: 'report', title: 'x', ttl_minutes: 5 },
  ]) {
    const r = await post(body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(dbApi.listActiveNotifications().length, before);
});
