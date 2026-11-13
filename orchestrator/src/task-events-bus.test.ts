/**
 * Kanban lifecycle on the bus: `task_created`, `task_updated` (with what
 * changed), `task_assigned`, `task_deleted` (snapshot taken before the cascade),
 * and the writer each one is read under.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { bus, type BusEvent } from './bus.js';
import { dbApi } from './db.js';
import { currentTaskOrigin, withTaskOrigin, type TaskOrigin } from './task-origin.js';

type Seen = { ev: BusEvent; origin: TaskOrigin };

function record(kinds: readonly string[], fn: () => void): Seen[] {
  const seen: Seen[] = [];
  const onEvent = (ev: BusEvent) => { if (kinds.includes(ev.kind)) seen.push({ ev, origin: currentTaskOrigin() }); };
  bus.on('event', onEvent);
  try { fn(); } finally { bus.off('event', onEvent); }
  return seen;
}
const ALL = ['task_created', 'task_updated', 'task_assigned', 'task_deleted', 'task_done', 'task_blocked', 'task_unblocked'];
const mk = (opts: { mirror?: boolean } = {}) => {
  const id = randomUUID();
  dbApi.createTask(id, 'Bus witness', 'witness', { description: 'secret body', ...opts });
  return id;
};

test('creation publishes task_created under the writer, the daemon by default', () => {
  let id = '';
  const seen = record(ALL, () => { id = mk(); });
  assert.deepEqual(seen.map((s) => s.ev.kind), ['task_created']);
  assert.deepEqual(seen[0]!.origin, { kind: 'system', id: null });
  const plugin = record(ALL, () => { withTaskOrigin({ kind: 'plugin', id: 'sync' }, () => mk()); });
  assert.deepEqual(plugin[0]!.origin, { kind: 'plugin', id: 'sync' });
  assert.equal(dbApi.getTask(id)?.title, 'Bus witness');
});

test('an edit lists what changed and what it was; an untouched write says nothing', () => {
  const id = mk();
  const seen = record(ALL, () => {
    dbApi.updateTask(id, { title: 'Renamed', priority: 5 });
    dbApi.updateTask(id, { title: 'Renamed' });
  });
  assert.equal(seen.length, 1);
  const ev = seen[0]!.ev as Extract<BusEvent, { kind: 'task_updated' }>;
  assert.deepEqual([...ev.changed].sort(), ['priority', 'title']);
  assert.equal(ev.previous.title, 'Bus witness');
  assert.equal(ev.previous.priority, 3);
});

test('changing the agent publishes task_assigned with the previous one', () => {
  const id = mk();
  const seen = record(ALL, () => dbApi.updateTask(id, { agentName: 'other-agent' }));
  assert.deepEqual(seen.map((s) => s.ev.kind), ['task_updated', 'task_assigned']);
  assert.equal((seen[1]!.ev as Extract<BusEvent, { kind: 'task_assigned' }>).previousAgent, 'witness');
});

test('status moves publish task_updated whichever path wrote them, next to the legacy events', () => {
  const id = mk();
  const mission = randomUUID();
  dbApi.createMission(mission, 'witness', 'run the witness');
  const seen = record(ALL, () => {
    dbApi.updateTaskStatus(id, 'BLOCKED', { blockedReason: 'why' });
    dbApi.updateTaskStatus(id, 'PENDING');
    dbApi.assignTaskMission(id, mission);
    dbApi.setTaskStatusOnly(id, 'DONE');
  });
  const kinds = seen.map((s) => s.ev.kind);
  assert.deepEqual(kinds, [
    'task_blocked', 'task_updated', 'task_unblocked', 'task_updated', 'task_updated', 'task_done', 'task_updated',
  ]);
  const statuses = seen.filter((s) => s.ev.kind === 'task_updated')
    .map((s) => (s.ev as Extract<BusEvent, { kind: 'task_updated' }>).previous.status);
  assert.deepEqual(statuses, ['PENDING', 'BLOCKED', 'PENDING', 'IN_PROGRESS']);
});

test('task_deleted carries the snapshot with the refs the cascade removes, once the delete committed', () => {
  const id = mk({ mirror: true });
  dbApi.putTaskExternalRef({ taskId: id, provider: 'github', ref: `o/r#${randomUUID()}`, url: 'https://x.test', label: null, pluginId: 'sync' });
  let during: unknown;
  const seen = record(ALL, () => {
    const onEvent = () => { during = dbApi.getTask(id); };
    bus.once('event', onEvent);
    withTaskOrigin({ kind: 'user', id: 'u1' }, () => dbApi.deleteTask(id));
  });
  assert.equal(during, undefined, 'the row is gone when the event is published');
  const ev = seen.find((s) => s.ev.kind === 'task_deleted')!;
  assert.deepEqual(ev.origin, { kind: 'user', id: 'u1' });
  const snap = (ev.ev as Extract<BusEvent, { kind: 'task_deleted' }>).task;
  assert.equal(snap.id, id);
  assert.equal(snap.mirror, true);
  assert.equal(snap.links.length, 1);
  assert.equal(snap.links[0]!.provider, 'github');
  assert.ok(!('description' in snap), 'the snapshot never carries the task body');
});

test('a refused delete announces nothing', () => {
  const id = mk();
  dbApi.updateTaskStatus(id, 'IN_PROGRESS');
  const seen = record(ALL, () => assert.equal(dbApi.deleteTask(id).result, 'state'));
  assert.equal(seen.filter((s) => s.ev.kind === 'task_deleted').length, 0);
});
