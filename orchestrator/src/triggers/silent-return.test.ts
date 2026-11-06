/**
 * `silent_return` on a trigger's task action: the investigation of a Discord
 * ticket reports into its idea, and its work return must not reach the
 * orchestrator, whose thread it would pollute. Off, the return goes up as
 * before.
 *
 * The flag lives in `tasks.silent_return` because dispatch re-arms
 * `return_notified`: a value posted only at creation would be wiped by the
 * first `assignTaskMission`.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TriggerInput } from './payload.js';
import { actionSchema, type TriggerAction } from './schema.js';
import type { Trigger } from './store.js';

const { dbApi } = await import('../db.js');
const { runActions } = await import('./actions.js');
const { handleTaskDone } = await import('../wake.js');
const { enqueueMissionReturn } = await import('../mission-return.js');
const { applyTodoClosure } = await import('../todo-closure.js');

const owner = createTestAccount(dbApi, { email: 'silent-return@example.com', name: 'Owner', passwordHash: 'x', isSuperadmin: false });

function trigger(actions: TriggerAction[]): Trigger {
  return {
    id: 'trg-silent-return', name: 'Discord: new TIM/SUG', enabled: true, filter: null, actions, secret: null,
    ownerUserId: owner.id, createdBy: owner.id, creatorAgent: null, actingAgent: null, grants: null,
    lastRunAt: null, nextRunAt: null, createdAt: 0, updatedAt: 0,
    source: 'event', slug: null, config: { event: 'task_done' },
  } as Trigger;
}

const TODO: TriggerAction = { type: 'todo', text: 'TIM-0999 {title}' };
const input: TriggerInput = { body: { title: 'canvas freezes' }, headers: {} };

function research(silent?: boolean): TriggerAction {
  return { type: 'task', agent: 'timon.researcher', prompt: 'Study {title}', task_type: 'research', ...(silent === undefined ? {} : { silent_return: silent }) };
}

/** Every message the closure or the mission's end could have queued for this task. */
function returnsFor(taskId: string) {
  return dbApi.listInbox('timon.main', { limit: 200 })
    .concat(dbApi.listInbox('_main', { limit: 200 }))
    .map((m) => JSON.parse(m.payload) as { kind?: string; task_id?: string })
    .filter((p) => p.task_id === taskId);
}

/** Dispatch as the dispatcher does, close DONE, then run both return paths. */
function runAndClose(taskId: string): boolean {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'timon.researcher', 'investigation');
  dbApi.setMissionLineage(missionId, { parentAgent: 'timon.main', taskId });
  dbApi.assignTaskMission(taskId, missionId);
  dbApi.updateTaskStatus(taskId, 'DONE', { doneComment: 'report written into the idea' });
  handleTaskDone(taskId);
  return enqueueMissionReturn(missionId, 'completed');
}

function taskOf(outcomes: ReturnType<typeof runActions>): string {
  const last = outcomes.at(-1);
  assert.ok(last?.ok, JSON.stringify(last));
  return String(last.id);
}

test('the schema accepts silent_return, and only as a boolean', () => {
  assert.equal(actionSchema.safeParse(research(true)).success, true);
  assert.equal(actionSchema.safeParse({ ...research(), silent_return: 'yes' }).success, false);
});

test('a dry run shows the flag, off by default', () => {
  const [preview] = runActions(trigger([research(true)]), input, { dryRun: true });
  assert.ok(preview?.ok);
  assert.equal(preview.preview?.silentReturn, true);
  const [loud] = runActions(trigger([research()]), input, { dryRun: true });
  assert.ok(loud?.ok);
  assert.equal(loud.preview?.silentReturn, false);
});

test('silent_return: true — nothing reaches the pilot at closure, the idea is still analyzed', () => {
  const outcomes = runActions(trigger([TODO, research(true)]), input);
  const taskId = taskOf(outcomes);
  const todoId = Number(outcomes[0]!.ok && outcomes[0]!.id);
  assert.equal(dbApi.getTask(taskId)?.silent_return, 1);

  assert.equal(runAndClose(taskId), false, 'the mission return stays silent too');
  assert.deepEqual(returnsFor(taskId), []);

  const task = dbApi.getTask(taskId);
  assert.ok(task);
  assert.deepEqual(applyTodoClosure(task), [{ todoId, progress: 'analyzed' }]);
});

test('a silent task dispatched again (retry, requeue) stays silent', () => {
  const taskId = taskOf(runActions(trigger([research(true)]), input));
  const first = randomUUID();
  dbApi.createMission(first, 'timon.researcher', 'first attempt');
  dbApi.assignTaskMission(taskId, first);
  dbApi.updateTaskStatus(taskId, 'TODO');
  assert.equal(runAndClose(taskId), false);
  assert.deepEqual(returnsFor(taskId), []);
});

test('silent_return absent or false — the return goes up exactly as before', () => {
  for (const flag of [undefined, false]) {
    const taskId = taskOf(runActions(trigger([research(flag)]), input));
    assert.equal(dbApi.getTask(taskId)?.silent_return, 0);
    runAndClose(taskId);
    const sent = returnsFor(taskId);
    assert.equal(sent.length, 1, `flag ${String(flag)}`);
    assert.equal(sent[0]?.kind, 'task_closed');
  }
});
