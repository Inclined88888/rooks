/**
 * What the pilot sees of its own delegations.
 *
 * The two states that make a line appear and disappear are persisted, not
 * inferred: `parent_mission_id` (set by `setMissionLineage`) and
 * `return_notified` (set by `mission-return.ts` when the work comes back).
 * The route is exercised over HTTP because the filter is the whole feature —
 * a child whose return has been delivered must vanish, and a finished child
 * must never linger.
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

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-delegations-route-test-'));

const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');

type Delegation = { id: string; agent_name: string; excerpt: string; started_at: number };

async function get(path: string): Promise<{ status: number; body: { delegations?: Delegation[] } }> {
  const app = express();
  app.use(express.json());
  registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: r.status, body: (await r.json()) as { delegations?: Delegation[] } };
  } finally {
    server.close();
  }
}

const parent = randomUUID();
dbApi.createMission(parent, 'rooks.main', 'orchestrate');

function child(mission: string): string {
  const id = randomUUID();
  dbApi.createMission(id, 'rooks.coder', mission);
  dbApi.setMissionLineage(id, { parentMissionId: parent, parentAgent: 'rooks.main' });
  return id;
}

test('lists only the children still awaiting their return', async () => {
  const waiting = child('  first\n  brief  ');
  const answered = child('second brief');
  const finished = child('third brief');
  dbApi.markMissionReturnNotified(answered);
  dbApi.finishMission(finished, 'completed', 0);

  const r = await get(`/api/missions/${parent}/delegations`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.delegations?.map((d) => d.id), [waiting]);
  const only = r.body.delegations![0]!;
  assert.equal(only.agent_name, 'rooks.coder');
  // Whitespace collapsed: a multi-line brief must not paint as a blank strip.
  assert.equal(only.excerpt, 'first brief');
  assert.ok(only.started_at > 0);
});

test('a child whose TASK already reported is gone, though its process lives on', async () => {
  // `enqueueMissionReturn` returns early on that path and never sets the
  // mission marker: reading `return_notified` alone would keep the line until
  // the idle reap.
  const taskId = randomUUID();
  dbApi.createTask(taskId, 'ship the thing', 'rooks.coder');
  const withTask = randomUUID();
  dbApi.createMission(withTask, 'rooks.coder', 'fifth brief');
  dbApi.setMissionLineage(withTask, { parentMissionId: parent, parentAgent: 'rooks.main', taskId });

  const before = await get(`/api/missions/${parent}/delegations`);
  assert.ok(before.body.delegations?.some((d) => d.id === withTask));

  dbApi.markTaskReturnNotified(taskId);
  const after = await get(`/api/missions/${parent}/delegations`);
  assert.equal(after.body.delegations?.some((d) => d.id === withTask), false);
});

test('an unknown parent answers 404, never an empty list', async () => {
  const r = await get(`/api/missions/${randomUUID()}/delegations`);
  assert.equal(r.status, 404);
});

test('setting the lineage publishes the arrival of the child', () => {
  const seen: Array<{ missionId: string; parentMissionId: string; agent: string }> = [];
  const onEvent = (ev: { kind: string }) => {
    if (ev.kind === 'mission_child_started') {
      seen.push(ev as unknown as { missionId: string; parentMissionId: string; agent: string });
    }
  };
  bus.on('event', onEvent);
  try {
    const id = child('fourth brief');
    assert.deepEqual(
      seen.map((e) => ({ missionId: e.missionId, parentMissionId: e.parentMissionId, agent: e.agent })),
      [{ missionId: id, parentMissionId: parent, agent: 'rooks.coder' }],
    );
  } finally {
    bus.off('event', onEvent);
  }
});
