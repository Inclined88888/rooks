/**
 * Boot backfill of `trace_id` on a witness base: a parent → child → fork
 * chain, a task mission, rows inserted before their ancestor, dangling and
 * cyclic lineage, and rows that already carry a trace (PRD workflows §12.2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-trace-backfill-test-'));

const { db, dbApi } = await import('./db.js');
const { backfillTraceIds, backfillTraceIdsAtBoot } = await import('./trace-backfill.js');

const trace = (id: string): string | null =>
  (db.prepare(`SELECT trace_id FROM missions WHERE id = ?`).get(id) as { trace_id: string | null }).trace_id;
const setLineage = db.prepare(
  `UPDATE missions SET parent_mission_id = ?, forked_from = ?, task_id = ?, trace_id = NULL WHERE id = ?`,
);

const root = randomUUID();
const child = randomUUID();
const fork = randomUUID();
const grandchild = randomUUID();
const task = randomUUID();
const taskMission = randomUUID();
const dangling = randomUUID();
const cycleA = randomUUID();
const cycleB = randomUUID();
const kept = randomUUID();
const message = randomUUID();

test('backfill resolves the whole chain and leaves nothing NULL', () => {
  // The grandchild is inserted FIRST: its ancestors have a higher rowid, so a
  // single ordered pass could not resolve it — inheritance must converge.
  dbApi.createMission(grandchild, 'a', 'grandchild of the fork');
  dbApi.createMission(root, 'a', 'root');
  dbApi.createMission(child, 'a', 'child');
  dbApi.createMission(fork, 'a', 'fork of the child');
  dbApi.createMission(taskMission, 'a', 'mission of a task created by root');
  dbApi.createMission(dangling, 'a', 'parent that does not exist');
  dbApi.createMission(cycleA, 'a', 'cycle a');
  dbApi.createMission(cycleB, 'a', 'cycle b');
  dbApi.createMission(kept, 'a', 'already traced');
  dbApi.createTask(task, 'task by root', 'a', { creatorMissionId: root });
  dbApi.enqueueMessage({ id: message, fromMission: child, fromAgent: 'a', toAgent: 'b', payload: 'hi' });

  setLineage.run(null, null, null, root);
  setLineage.run(root, null, null, child);
  setLineage.run(null, child, null, fork);
  setLineage.run(fork, null, null, grandchild);
  setLineage.run(null, null, task, taskMission);
  setLineage.run(randomUUID(), null, null, dangling);
  setLineage.run(cycleB, null, null, cycleA);
  setLineage.run(cycleA, null, null, cycleB);
  setLineage.run(null, null, null, kept);
  db.prepare(`UPDATE missions SET trace_id = 'keep-me' WHERE id = ?`).run(kept);
  db.prepare(`UPDATE tasks SET trace_id = NULL WHERE id = ?`).run(task);
  db.prepare(`UPDATE agent_messages SET trace_id = NULL WHERE id = ?`).run(message);

  const report = backfillTraceIds();
  assert.equal(report.missions, 8, 'every NULL mission filled, the traced one untouched');
  assert.equal(report.tasks, 1);
  assert.equal(report.messages, 1);

  assert.equal(trace(root), root, 'a root is its own trace');
  assert.equal(trace(child), root, 'parent_mission_id');
  assert.equal(trace(fork), root, 'forked_from');
  assert.equal(trace(grandchild), root, 'resolved although inserted before its ancestors');
  assert.equal(trace(taskMission), root, 'task_id → tasks.creator_mission_id');
  assert.equal(trace(dangling), dangling, 'unknown parent → own root');
  assert.equal(trace(cycleA), cycleA, 'cycle → own root, never NULL');
  assert.equal(trace(cycleB), cycleB);
  assert.equal(trace(kept), 'keep-me', 'an existing trace_id is never rewritten');
  assert.equal(dbApi.getTask(task)?.trace_id, root);
  assert.equal(dbApi.getMessage(message)?.trace_id, root);

  const nulls = db.prepare(`SELECT COUNT(*) AS n FROM missions WHERE trace_id IS NULL`).get() as { n: number };
  assert.equal(nulls.n, 0, 'invariant §12.2: no mission without trace_id after boot');
});

test('backfill is idempotent: a second run changes nothing', () => {
  assert.deepEqual(backfillTraceIds(), { missions: 0, tasks: 0, messages: 0 });
  assert.equal(trace(grandchild), root);
});

test('boot entry point never throws', () => {
  assert.deepEqual(backfillTraceIdsAtBoot(), { missions: 0, tasks: 0, messages: 0 });
});
