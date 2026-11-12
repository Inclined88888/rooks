/**
 * Fine mission state exposed to the clients: a `running` row whose turn ended
 * must not read as an active process, and a cut mission must not read as idle.
 *
 * `npm test -- src/mission-liveness.test.ts`
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

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-liveness-test-'));

const { missionLiveness } = await import('./mission-liveness.js');
const { db, dbApi } = await import('./db.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');

const base = { status: 'running', process_alive: true, turn_active: false, turn_complete: false, interrupted_reason: null };

test('a live process in a turn is working', () => {
  assert.equal(missionLiveness({ ...base, turn_active: true }).liveness, 'working');
});

test('a live process after a finished turn is turn_done, not working', () => {
  assert.equal(missionLiveness({ ...base, turn_complete: true }).liveness, 'turn_done');
});

test('an open row with no process, or no finished turn yet, is open', () => {
  assert.equal(missionLiveness({ ...base, process_alive: false, turn_complete: true }).liveness, 'open');
  assert.equal(missionLiveness(base).liveness, 'open');
});

test('an interruption cause wins over a live process that is not in a turn', () => {
  assert.deepEqual(
    missionLiveness({ ...base, turn_complete: true, interrupted_reason: 'rate_limit' }),
    { liveness: 'interrupted', interrupted_reason: 'rate_limit' },
  );
  assert.equal(missionLiveness({ ...base, process_alive: false, interrupted_reason: 'crash' }).liveness, 'interrupted');
});

test('a finished mission is interrupted only when a cause was recorded', () => {
  assert.equal(missionLiveness({ ...base, status: 'completed', process_alive: false }).liveness, 'ended');
  assert.equal(missionLiveness({ ...base, status: 'terminated', process_alive: false, interrupted_reason: 'killed' }).liveness, 'interrupted');
});

test('an unknown stored cause is not an interruption', () => {
  const r = missionLiveness({ ...base, status: 'failed', process_alive: false, interrupted_reason: 'garbage' });
  assert.deepEqual(r, { liveness: 'ended', interrupted_reason: null });
});

type Listed = { id: string; liveness?: string; turn_complete?: boolean; interrupted_reason?: string | null; pending_messages?: number; open_deliveries?: number };

async function get<T>(path: string): Promise<T> {
  const app = express();
  app.use(express.json());
  registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    return (await (await fetch(`http://127.0.0.1:${port}${path}`)).json()) as T;
  } finally {
    server.close();
  }
}

test('the list and the detail carry liveness and the work still owed', async () => {
  const id = randomUUID();
  dbApi.createMission(id, 'ghost-agent', 'a brief');
  dbApi.insertEvent(id, 'result', { subtype: 'success' });

  const plain = await get<{ missions: Listed[] }>('/api/missions');
  const row = plain.missions.find((m) => m.id === id)!;
  // No process in this test: the row is open, the turn is over.
  assert.equal(row.liveness, 'open');
  assert.equal(row.turn_complete, true);
  assert.equal(row.pending_messages, 0);
  assert.equal(row.open_deliveries, 0);

  const sender = randomUUID();
  dbApi.createMission(sender, 'pilot', 'pilot brief');
  dbApi.enqueueMessage({ id: randomUUID(), fromMission: sender, fromAgent: 'pilot', toAgent: 'ghost-agent', payload: 'one' });
  dbApi.enqueueMessage({ id: randomUUID(), fromMission: sender, fromAgent: 'pilot', toAgent: 'ghost-agent', toMission: id, payload: 'two' });
  // A human escalation waits for a person: it is not owed to the mission.
  dbApi.enqueueMessage({ id: randomUUID(), fromMission: sender, fromAgent: 'orchestrator', toAgent: 'ghost-agent', payload: 'escalation' });
  // Addressed to another mission of the same agent: not this one's.
  const other = randomUUID();
  dbApi.createMission(other, 'ghost-agent', 'other');
  dbApi.enqueueMessage({ id: randomUUID(), fromMission: sender, fromAgent: 'pilot', toAgent: 'ghost-agent', toMission: other, payload: 'three' });
  const request = randomUUID();
  dbApi.enqueueMessage({ id: request, fromMission: sender, fromAgent: 'pilot', toAgent: 'ghost-agent', kind: 'request', toMission: id, payload: 'answer' });
  db.prepare(`UPDATE agent_messages SET status = 'picked' WHERE id = ?`).run(request);
  const ev = dbApi.insertEvent(id, 'user', { message: { content: 'answer' } });
  db.prepare('INSERT INTO agent_request_deliveries (request_id, mission_id, event_id) VALUES (?, ?, ?)').run(request, id, ev.id);

  const detail = await get<Listed>(`/api/missions/${id}?view=status`);
  assert.equal(detail.pending_messages, 2);
  assert.equal(detail.open_deliveries, 1);
  assert.equal(detail.turn_complete, false); // a user event reopened the turn
  assert.equal(detail.liveness, 'open');
});

test('a mission closed with a cause lists as interrupted with that cause', async () => {
  const id = randomUUID();
  dbApi.createMission(id, 'ghost-agent', 'a brief');
  dbApi.finishMission(id, 'terminated', 0, 'killed');
  const detail = await get<Listed>(`/api/missions/${id}?view=status`);
  assert.equal(detail.liveness, 'interrupted');
  assert.equal(detail.interrupted_reason, 'killed');
});

test('the agent inbox is not credited to a finished mission, only what names it', async () => {
  const id = randomUUID();
  dbApi.createMission(id, 'inbox-agent', 'a brief');
  const sender = randomUUID();
  dbApi.createMission(sender, 'pilot', 'pilot brief');
  dbApi.enqueueMessage({ id: randomUUID(), fromMission: sender, fromAgent: 'pilot', toAgent: 'inbox-agent', payload: 'for the next mission' });
  dbApi.enqueueMessage({ id: randomUUID(), fromMission: sender, fromAgent: 'pilot', toAgent: 'inbox-agent', toMission: id, payload: 'for this one' });
  assert.equal((await get<Listed>(`/api/missions/${id}?view=status`)).pending_messages, 2);
  dbApi.finishMission(id, 'completed', 0);
  assert.equal((await get<Listed>(`/api/missions/${id}?view=status`)).pending_messages, 1);
});
