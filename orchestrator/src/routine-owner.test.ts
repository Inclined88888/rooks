/**
 * A routine runs on behalf of the account that created it: its tasks, and the
 * missions of those tasks, carry that account. A remote backend picks the
 * per-user connection from it (`BackendLaunchContext.ownerUserId`); a routine
 * with no owner left every such agent without a connection.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db, dbApi } = await import('./db.js');
const { createRoutine, tickRoutines } = await import('./routines.js');

function tickedTaskOf(routineId: string) {
  db.prepare(`UPDATE triggers SET next_run_at = 1 WHERE id = ?`).run(routineId);
  return tickRoutines().then(() => dbApi.listTasks().find((t) => t.routine_id === routineId));
}

test('the task a routine opens belongs to the routine\'s creator', async () => {
  const routine = createRoutine({
    name: 'Owned', agent_name: 'helper', prompt: 'Report.', cron_expr: '0 9 * * *', ownerUserId: 'user-routine-1',
  });
  assert.equal(dbApi.getRoutine(routine.id)?.owner_user_id, 'user-routine-1');
  const task = await tickedTaskOf(routine.id);
  assert.ok(task, 'the tick opened a task');
  assert.equal(task.owner_user_id, 'user-routine-1');
});

test('a routine created by the daemon itself stays ownerless', async () => {
  const routine = createRoutine({ name: 'Daemon', agent_name: 'helper', prompt: 'Report.', cron_expr: '0 9 * * *' });
  assert.equal(dbApi.getRoutine(routine.id)?.owner_user_id, null);
  const task = await tickedTaskOf(routine.id);
  assert.ok(task);
  assert.equal(task.owner_user_id, null);
});
