/**
 * `task_started` (TODO #424): the opt-in "a task started" sound and toast hang
 * on it, so it must go out ONCE per task — at its first dispatch — and never
 * again for a requeue after a system death, a human restart or a repair.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-task-started-test-'));

const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');

type Started = { taskId: string; followUp: boolean };

function startsDuring(fn: () => void): Started[] {
  const seen: Started[] = [];
  const listener = (ev: { kind: string; taskId?: string; followUp?: boolean }) => {
    if (ev.kind === 'task_started') seen.push({ taskId: ev.taskId!, followUp: ev.followUp! });
  };
  bus.on('event', listener);
  try { fn(); } finally { bus.off('event', listener); }
  return seen;
}

function dispatch(taskId: string): void {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'tester', 'task mission');
  dbApi.assignTaskMission(taskId, missionId);
}

test('the first dispatch of a task announces its start, once', () => {
  const id = randomUUID();
  dbApi.createTask(id, 'feature', 'tester', { type: 'code', pipeline: 'full' });
  assert.equal(dbApi.getTask(id)?.started_at, null);
  const seen = startsDuring(() => dispatch(id));
  assert.deepEqual(seen, [{ taskId: id, followUp: false }]);
  assert.equal(typeof dbApi.getTask(id)?.started_at, 'number');
});

test('a requeue after a system death does not announce the task again', () => {
  const id = randomUUID();
  dbApi.createTask(id, 'requeued', 'tester', { type: 'doc' });
  dispatch(id);
  const firstStart = dbApi.getTask(id)?.started_at;
  const seen = startsDuring(() => {
    assert.equal(dbApi.setTaskInterrupted(id, 'killed', 'process killed'), 'requeued');
    assert.equal(dbApi.getTask(id)?.status, 'PENDING');
    dispatch(id);
  });
  assert.deepEqual(seen, []);
  assert.equal(dbApi.getTask(id)?.started_at, firstStart, 'the first start is kept');
});

test('a task blocked then restarted by hand does not announce itself again', () => {
  const id = randomUUID();
  dbApi.createTask(id, 'restarted', 'tester', { type: 'chore' });
  dispatch(id);
  const seen = startsDuring(() => {
    dbApi.updateTaskStatus(id, 'BLOCKED', { blockedReason: 'needs a human' });
    dbApi.updateTaskStatus(id, 'PENDING');
    dispatch(id);
  });
  assert.deepEqual(seen, []);
});

test('a follow-up created by the orchestrator is flagged as such', () => {
  const root = randomUUID();
  const review = randomUUID();
  dbApi.createTask(root, 'root', 'tester', { type: 'code' });
  dbApi.createTask(review, 'review — root', 'tester', { type: 'review', parentTaskId: root });
  assert.equal(dbApi.getTask(review)?.parent_task_id, root);
  assert.equal(dbApi.getTask(root)?.parent_task_id, null);
  assert.deepEqual(startsDuring(() => dispatch(review)), [{ taskId: review, followUp: true }]);
});
