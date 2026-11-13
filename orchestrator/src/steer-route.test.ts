/**
 * `POST /api/missions/:id/steer` redirects a turn that is running. Its refusals
 * are the contract: a body that is not an instruction, a mission nobody runs,
 * and a caller who does not own the mission get distinct, readable answers —
 * and nothing is queued as a next turn.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import express from 'express';

const { dbApi } = await import('./db.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

test('an unknown mission is a 404, an empty or oversized instruction a 400', async () => {
  assert.equal((await post(`/api/missions/${randomUUID()}/steer`, { input: 'go left' })).status, 404);

  const missionId = randomUUID();
  dbApi.createMission(missionId, 'steer-agent', 'a conversation');
  for (const input of [undefined, '', '   ', 'x'.repeat(20_001), 42]) {
    const answered = await post(`/api/missions/${missionId}/steer`, { input });
    assert.equal(answered.status, 400, `input ${JSON.stringify(input)?.slice(0, 20)}`);
  }
});

test('a mission with no turn running is a 409 no_turn_to_steer, never a queued message', async () => {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'steer-agent', 'a conversation');
  const before = dbApi.listEvents(missionId).length;
  const answered = await post(`/api/missions/${missionId}/steer`, { input: 'go left' });
  assert.equal(answered.status, 409);
  assert.equal(answered.body.code, 'no_turn_to_steer');
  assert.equal(dbApi.listEvents(missionId).length, before, 'nothing was written to the conversation');
});
