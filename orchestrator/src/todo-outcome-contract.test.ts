/**
 * Contract of the idea-outcome events, as the Discord bot (rooks-discord,
 * `docs/rooks-webhook.md`) consumes them through two event triggers.
 *
 * Frozen on purpose: the outcome logic moves out of the core into a plugin,
 * and this file must stay green across that move. Only `setOutcome` below
 * changes when the write path moves; every assertion stays as it is.
 */
import './test-home.js';
// The outcome is opt-in; the contract is that of the enabled feature.
process.env.ROOKS_TODO_OUTCOME_ENABLED = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BusEvent } from './bus.js';

const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
const { eventFromBus } = await import('./triggers/events.js');
const { patchTodo } = await import('./plugins-bundled/kanban/todo-api.js');
const { registerTodoExtension } = await import('./project-todo-extensions.js');
const { outcomeExtension } = await import('./plugins-bundled/todo-outcomes/outcome.js');
const { ensureOutcomeTable } = await import('./plugins-bundled/todo-outcomes/store.js');
ensureOutcomeTable();
registerTodoExtension(outcomeExtension);

type Outcome = { resolution?: string | null; public_note?: string | null; duplicate_of?: string | null };
type Extra = { progress?: 'todo' | 'analyzed' | 'partial' | 'to_test' | 'done'; status?: 'open' | 'done' };

/** The one place that knows how an outcome is written: the PATCH path of the route. */
function setOutcome(id: number, outcome: Outcome, extra: Extra = {}): void {
  patchTodo(dbApi.getProjectTodo(id)!, extra, outcome);
}

function capture(fn: () => void): BusEvent[] {
  const seen: BusEvent[] = [];
  const on = (ev: BusEvent) => { if (ev.kind === 'todo_resolved' || ev.kind === 'todo_done') seen.push(ev); };
  bus.on('event', on);
  try { fn(); } finally { bus.off('event', on); }
  return seen;
}

test('a closing outcome publishes todo_resolved, then todo_done, with the bot payloads', () => {
  const todo = dbApi.insertProjectTodo({ text: 'TIM-0900 · contract', project: 'rooks', progress: 'analyzed' });
  const events = capture(() => setOutcome(todo.id, { resolution: 'duplicate', duplicate_of: 'TIM-0012', public_note: 'Same crash.' }));
  assert.deepEqual(events.map((e) => e.kind), ['todo_resolved', 'todo_done']);

  const resolved = events[0] as Extract<BusEvent, { kind: 'todo_resolved' }>;
  assert.equal(resolved.todoId, todo.id);
  assert.equal(resolved.previousResolution, null);
  assert.ok(Object.isFrozen(resolved.todo));
  assert.deepEqual({ ...resolved.todo }, {
    id: todo.id, text: 'TIM-0900 · contract', project: 'rooks', resolution: 'duplicate',
    public_note: 'Same crash.', duplicate_of: 'TIM-0012', owner_user_id: null,
  });
  const resolvedTrigger = eventFromBus(resolved);
  assert.equal(resolvedTrigger?.kind, 'todo_resolved');
  assert.deepEqual(resolvedTrigger?.body, {
    event: 'todo_resolved',
    todo: {
      id: todo.id, text: 'TIM-0900 · contract', project: 'rooks', resolution: 'duplicate',
      public_note: 'Same crash.', duplicate_of: 'TIM-0012',
    },
  });

  const done = events[1] as Extract<BusEvent, { kind: 'todo_done' }>;
  assert.deepEqual(done, { kind: 'todo_done', todoId: todo.id, previousProgress: 'analyzed' });
  const doneTrigger = eventFromBus(done);
  const body = doneTrigger?.body as { event: string; todo: Record<string, unknown> };
  assert.equal(body.event, 'todo_done');
  assert.deepEqual(Object.keys(body.todo).sort(), ['done_at', 'id', 'previous_progress', 'progress', 'project', 'text', 'urgency']);
  assert.equal(body.todo.progress, 'done');
  assert.equal(body.todo.previous_progress, 'analyzed');
  assert.equal(typeof body.todo.done_at, 'number');
});

test('each closing resolution closes the idea; the others only announce', () => {
  for (const resolution of ['fixed', 'declined', 'duplicate']) {
    const todo = dbApi.insertProjectTodo({ text: `TIM-0901 · ${resolution}` });
    const extra = resolution === 'duplicate' ? { duplicate_of: 'SUG-0001' } : {};
    const events = capture(() => setOutcome(todo.id, { resolution, ...extra }));
    assert.deepEqual(events.map((e) => e.kind), ['todo_resolved', 'todo_done'], resolution);
    assert.equal(dbApi.getProjectTodo(todo.id)?.status, 'done', resolution);
  }
  for (const resolution of ['needs_info', 'in_progress', 'planned']) {
    const todo = dbApi.insertProjectTodo({ text: `TIM-0902 · ${resolution}` });
    const events = capture(() => setOutcome(todo.id, { resolution }));
    assert.deepEqual(events.map((e) => e.kind), ['todo_resolved'], resolution);
    assert.equal(dbApi.getProjectTodo(todo.id)?.status, 'open', resolution);
  }
});

test('a change of outcome carries the previous one', () => {
  const todo = dbApi.insertProjectTodo({ text: 'SUG-0903 · change' });
  setOutcome(todo.id, { resolution: 'planned' });
  const events = capture(() => setOutcome(todo.id, { resolution: 'in_progress' }));
  const resolved = events[0] as Extract<BusEvent, { kind: 'todo_resolved' }>;
  assert.equal(resolved.previousResolution, 'planned');
  assert.equal(resolved.todo.resolution, 'in_progress');
});

test('re-saving the same outcome, or clearing it, announces nothing', () => {
  const todo = dbApi.insertProjectTodo({ text: 'TIM-0904 · quiet' });
  setOutcome(todo.id, { resolution: 'planned' });
  assert.deepEqual(capture(() => setOutcome(todo.id, { resolution: 'planned' })), []);
  assert.deepEqual(capture(() => setOutcome(todo.id, { public_note: 'edited note' })), []);
  assert.deepEqual(capture(() => setOutcome(todo.id, { resolution: null })), []);
});

test('a closing outcome on a promoted idea announces it without closing the idea', () => {
  const todo = dbApi.insertProjectTodo({ text: 'TIM-0905 · promoted' });
  dbApi.markProjectTodoPromoted(todo.id, 'task-0905');
  const events = capture(() => setOutcome(todo.id, { resolution: 'fixed' }));
  assert.deepEqual(events.map((e) => e.kind), ['todo_resolved']);
  assert.equal(dbApi.getProjectTodo(todo.id)?.status, 'promoted');
});

test('an explicit progress in the same write wins over the closing outcome', () => {
  const todo = dbApi.insertProjectTodo({ text: 'TIM-0906 · explicit' });
  const events = capture(() => setOutcome(todo.id, { resolution: 'fixed' }, { progress: 'to_test' }));
  assert.deepEqual(events.map((e) => e.kind), ['todo_resolved']);
  assert.equal(dbApi.getProjectTodo(todo.id)?.status, 'open');
  assert.equal(dbApi.getProjectTodo(todo.id)?.progress, 'to_test');
});

test('a closing outcome on an idea already done announces the outcome only', () => {
  const todo = dbApi.insertProjectTodo({ text: 'TIM-0907 · already done' });
  dbApi.updateProjectTodo(todo.id, { status: 'done' });
  const events = capture(() => setOutcome(todo.id, { resolution: 'fixed' }));
  assert.deepEqual(events.map((e) => e.kind), ['todo_resolved']);
});

test('leaving duplicate drops the reference it carried', () => {
  const todo = dbApi.insertProjectTodo({ text: 'TIM-0908 · was dup' });
  setOutcome(todo.id, { resolution: 'duplicate', duplicate_of: 'TIM-0001' });
  const events = capture(() => setOutcome(todo.id, { resolution: 'declined' }));
  const resolved = events[0] as Extract<BusEvent, { kind: 'todo_resolved' }>;
  assert.equal(resolved.todo.duplicate_of, null);
});
