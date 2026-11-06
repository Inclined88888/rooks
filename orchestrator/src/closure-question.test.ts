/**
 * TIM-0092: a task mission that ends its turn without closing its task is
 * ASKED whether it is finished, instead of being reaped and requeued.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-closure-question-test-'));

const { dbApi } = await import('./db.js');
const { askUnclosedTaskMission, CLOSURE_QUESTION } = await import('./wake.js');

function taskMission(): { missionId: string; taskId: string } {
  const taskId = randomUUID();
  const missionId = randomUUID();
  dbApi.createTask(taskId, 'a task', 'p.coder', { type: 'code' });
  dbApi.createMission(missionId, 'p.coder', 'work', { channel: 'dispatcher' });
  dbApi.setMissionLineage(missionId, { taskId });
  dbApi.assignTaskMission(taskId, missionId);
  return { missionId, taskId };
}

test('an open task is asked, at most twice', async () => {
  const { missionId } = taskMission();
  const sent: string[] = [];
  const send = async (_id: string, text: string) => { sent.push(text); return 'delivered'; };
  assert.equal(await askUnclosedTaskMission(missionId, send), true);
  assert.equal(await askUnclosedTaskMission(missionId, send), true);
  assert.equal(await askUnclosedTaskMission(missionId, send), false);
  assert.deepEqual(sent, [CLOSURE_QUESTION, CLOSURE_QUESTION]);
});

test('a closed task is not asked', async () => {
  const { missionId, taskId } = taskMission();
  dbApi.updateTaskStatus(taskId, 'DONE', 'finished');
  let called = false;
  const send = async () => { called = true; return 'delivered'; };
  assert.equal(await askUnclosedTaskMission(missionId, send), false);
  assert.equal(called, false);
});

test('a mission without task is not asked', async () => {
  const id = randomUUID();
  dbApi.createMission(id, 'p.coder', 'chat');
  assert.equal(await askUnclosedTaskMission(id, async () => 'delivered'), false);
});
