/**
 * A trigger that files an idea then a task (the Discord TIM/SUG route) links
 * the task to that idea, so the task's closure settles it. Without the link the
 * research ran, finished, and the idea stayed `todo` forever.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TriggerInput } from './payload.js';
import type { TriggerAction } from './schema.js';
import type { Trigger } from './store.js';

const { dbApi } = await import('../db.js');
const { runActions } = await import('./actions.js');
const { applyTodoClosure } = await import('../todo-closure.js');

const owner = createTestAccount(dbApi, { email: 'todo-link@example.com', name: 'Owner', passwordHash: 'x', isSuperadmin: false });

function trigger(actions: TriggerAction[]): Trigger {
  return {
    id: 'trg-todo-link', name: 'Discord: new TIM/SUG', enabled: true, filter: null, actions, secret: null,
    ownerUserId: owner.id, createdBy: owner.id, creatorAgent: null, actingAgent: null, grants: null,
    lastRunAt: null, nextRunAt: null, createdAt: 0, updatedAt: 0,
    source: 'event', slug: null, config: { event: 'task_done' },
  } as Trigger;
}

const TODO: TriggerAction = { type: 'todo', text: 'SUG-0023 {title}' };
const RESEARCH: TriggerAction = { type: 'task', agent: 'rooks.researcher', prompt: 'Study {title}', task_type: 'research' };
const input: TriggerInput = { body: { title: 'dark mode' }, headers: {} };

function idsOf(outcomes: ReturnType<typeof runActions>) {
  return outcomes.map((o) => {
    assert.ok(o.ok, JSON.stringify(o));
    return o.id;
  });
}

test('the task carries the id of the idea filed just before it', () => {
  const [todoId, taskId] = idsOf(runActions(trigger([TODO, RESEARCH]), input));
  assert.equal(typeof todoId, 'number');
  assert.equal(dbApi.getTask(String(taskId))?.todo_id, todoId);
});

test('no todo action, no link — and a task filed before the idea is not linked either', () => {
  const [alone] = idsOf(runActions(trigger([RESEARCH]), input));
  assert.equal(dbApi.getTask(String(alone))?.todo_id, null);
  const [before] = idsOf(runActions(trigger([RESEARCH, TODO]), input));
  assert.equal(dbApi.getTask(String(before))?.todo_id, null);
});

test('several ideas: the task takes the last one filed before it', () => {
  const [, second, taskId] = idsOf(runActions(trigger([TODO, TODO, RESEARCH]), input));
  assert.equal(dbApi.getTask(String(taskId))?.todo_id, second);
});

test('a dry run renders without filing anything to link', () => {
  const outcomes = runActions(trigger([TODO, RESEARCH]), input, { dryRun: true });
  assert.deepEqual(outcomes.map((o) => o.ok && o.id), [null, null]);
});

test('the research task DONE leaves its idea analyzed, never done', () => {
  const [todoId, taskId] = idsOf(runActions(trigger([TODO, RESEARCH]), input));
  dbApi.updateTaskStatus(String(taskId), 'DONE', { doneComment: 'findings in the vault' });
  const task = dbApi.getTask(String(taskId));
  assert.ok(task);
  assert.deepEqual(applyTodoClosure(task), [{ todoId, progress: 'analyzed' }]);
  const todo = dbApi.getProjectTodo(Number(todoId));
  assert.equal(todo?.progress, 'analyzed');
  assert.notEqual(todo?.status, 'done');
});
