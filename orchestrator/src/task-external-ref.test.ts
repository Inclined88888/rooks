import './test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { dbApi } from './db.js';

function seed(opts: { mirror?: boolean } = {}): string {
  const id = randomUUID();
  dbApi.createTask(id, 'Ref witness', 'witness', opts);
  return id;
}

test('a ref points at one task and is found by (provider, ref)', () => {
  const a = seed(), b = seed();
  const ref = `acme/${randomUUID()}#1`;
  const row = dbApi.putTaskExternalRef({ taskId: a, provider: 'github', ref, url: 'https://x.test/1', label: null, pluginId: 'p' });
  assert.equal(row.task_id, a);
  assert.equal(dbApi.getTaskExternalRef('github', ref)?.task_id, a);
  // Re-putting for the same task refreshes; for another task it never steals the ref.
  dbApi.putTaskExternalRef({ taskId: a, provider: 'github', ref, url: 'https://x.test/2', label: 'l', pluginId: null });
  assert.equal(dbApi.getTaskExternalRef('github', ref)?.url, 'https://x.test/2');
  assert.equal(dbApi.getTaskExternalRef('github', ref)?.plugin_id, 'p');
  dbApi.putTaskExternalRef({ taskId: b, provider: 'github', ref, url: null, label: null, pluginId: null });
  assert.equal(dbApi.getTaskExternalRef('github', ref)?.task_id, a);
  assert.equal(dbApi.listTaskExternalRefs([a, b]).length, 1);
});

test('deleting a task takes its refs with it', () => {
  const id = seed();
  const ref = randomUUID();
  dbApi.putTaskExternalRef({ taskId: id, provider: 'linear', ref, url: null, label: null, pluginId: null });
  assert.equal(dbApi.deleteTask(id).result, 'deleted');
  assert.equal(dbApi.getTaskExternalRef('linear', ref), undefined);
});

test('removing a ref is exact on task, provider and ref', () => {
  const id = seed(), other = seed();
  const ref = randomUUID();
  dbApi.putTaskExternalRef({ taskId: id, provider: 'jira', ref, url: null, label: null, pluginId: null });
  assert.equal(dbApi.deleteTaskExternalRef(other, 'jira', ref), false);
  assert.equal(dbApi.deleteTaskExternalRef(id, 'jira', ref), true);
  assert.equal(dbApi.deleteTaskExternalRef(id, 'jira', ref), false);
});

test('a mirror task is never offered to the dispatcher', () => {
  const real = seed(), mirror = seed({ mirror: true });
  assert.equal(dbApi.getTask(mirror)?.mirror, 1);
  assert.equal(dbApi.getTask(real)?.mirror, 0);
  const ready = dbApi.listPendingReady().map((t) => t.id);
  assert.ok(ready.includes(real));
  assert.ok(!ready.includes(mirror));
});
