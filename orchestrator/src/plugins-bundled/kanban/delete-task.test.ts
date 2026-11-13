import '../../test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test, after } from 'node:test';
import { join } from 'node:path';
import express from 'express';
import { db, dbApi } from '../../db.js';
import { registerRoutes } from './routes.js';
import { createDaemonAuthMiddleware } from '../http/auth.js';
await import('../../../tests/helpers/claude-provider.js');

const app = express();
app.use(createDaemonAuthMiddleware({ token: 'delete-test', required: true }));
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
function remove(id: string, authenticated = true) {
  return fetch(`${base}/api/tasks/${id}`, {
    method: 'DELETE', headers: authenticated ? { Authorization: 'Bearer delete-test' } : {},
  });
}
function seed(status = 'PENDING') {
  const id = randomUUID();
  dbApi.createTask(id, 'Deletion witness', 'witness');
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, id);
  return id;
}
for (const status of ['PENDING', 'BLOCKED']) {
  test(`deletes an unreferenced ${status} task`, async () => {
    const id = seed(status);
    assert.equal((await remove(id)).status, 200);
    assert.equal(dbApi.getTask(id), undefined);
  });
  test(`refuses a ${status} pipeline step without a SQLite 500`, async () => {
    const id = seed(status), pipeline = randomUUID(), run = randomUUID();
    db.prepare('INSERT INTO pipelines (id, name, description, definition, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)').run(pipeline, 'Witness', '{}', 1, 1);
    db.prepare('INSERT INTO pipeline_runs (id, pipeline_id, input_payload, started_at) VALUES (?, ?, NULL, ?)').run(run, pipeline, 1);
    db.prepare('INSERT INTO pipeline_run_steps VALUES (?, ?, ?)').run(run, 'step', id);
    const response = await remove(id);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'task_pipeline');
    assert.ok(dbApi.getTask(id));
  });
}
for (const reason of ['state', 'dependents', 'mission', 'worktree']) {
  test(`refuses deletion with ${reason}`, async () => {
    const id = seed(reason === 'state' ? 'IN_PROGRESS' : 'BLOCKED');
    if (reason === 'dependents') dbApi.createTask(randomUUID(), 'Dependent', 'witness', { deps: [id] });
    if (reason === 'mission') {
      const mission = randomUUID();
      dbApi.createMission(mission, 'witness', 'Running');
      db.prepare('UPDATE missions SET task_id = ? WHERE id = ?').run(id, mission);
    }
    if (reason === 'worktree') dbApi.setTaskWorktree(id, process.env.ROOKS_HOME!, 'witness', 'main');
    const response = await remove(id);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, `task_${reason}`);
    assert.ok(dbApi.getTask(id));
  });
}
test('deletes a task whose worktree folder no longer exists', async () => {
  const id = seed('BLOCKED');
  dbApi.setTaskWorktree(id, join(process.env.ROOKS_HOME!, 'gone', id), 'witness', 'main');
  assert.equal((await remove(id)).status, 200);
  assert.equal(dbApi.getTask(id), undefined);
});
test('anonymous deletion is denied without changing the task', async () => {
  const id = seed();
  assert.equal((await remove(id, false)).status, 401);
  assert.ok(dbApi.getTask(id));
});
test('unknown and invalid identifiers return explicit client errors', async () => {
  assert.equal((await remove(randomUUID())).status, 404);
  assert.equal((await remove('invalid!')).status, 400);
});

test('verification children keep their root even without an explicit dependency', async () => {
  const root = seed(), child = seed();
  db.prepare('UPDATE tasks SET verification_root_id = ? WHERE id = ?').run(root, child);
  const response = await remove(root);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'task_chain');
  assert.ok(dbApi.getTask(root));
});

/** The TIM-0078 board: a BLOCKED root, two review iterations and a repair, all
 *  tagged with the root and only partly linked through `deps`. */
function seedChain() {
  const root = seed('BLOCKED');
  const review1 = randomUUID(), code2 = randomUUID(), review2 = randomUUID();
  // Same shape as verification-loop: parent, project and deps on the previous step.
  db.prepare("UPDATE tasks SET project = 'witness-project' WHERE id = ?").run(root);
  const lineage = (parent: string) => ({ deps: [parent], project: 'witness-project', parentTaskId: parent });
  dbApi.createTask(review1, 'review iter:1', 'witness', { ...lineage(root), type: 'review' });
  dbApi.createTask(code2, 'code iter:2', 'witness', { ...lineage(review1), type: 'code' });
  dbApi.createTask(review2, 'review iter:2', 'witness', { ...lineage(code2), type: 'review' });
  for (const [id, iteration] of [[review1, 1], [code2, 2], [review2, 2]] as const) {
    dbApi.setTaskVerificationMeta(id, iteration, root);
    db.prepare("UPDATE tasks SET status = 'BLOCKED' WHERE id = ?").run(id);
  }
  return { root, children: [review1, code2, review2] };
}
function removeChain(id: string, authenticated = true) {
  return fetch(`${base}/api/tasks/${id}?chain=1`, {
    method: 'DELETE', headers: authenticated ? { Authorization: 'Bearer delete-test' } : {},
  });
}

test('a chain root is refused with the chain reason and its blocking tasks, then deleted with chain=1', async () => {
  const { root, children } = seedChain();
  const refused = await remove(root);
  assert.equal(refused.status, 409);
  const body = await refused.json() as { code: string; error: string; chain_size: number; blockers: { id: string; kind: string }[] };
  assert.equal(body.code, 'task_chain');
  assert.equal(body.chain_size, 4);
  assert.deepEqual(body.blockers.map((b) => b.id).sort(), [...children].sort());
  assert.ok(body.blockers.every((b) => b.kind === 'chain'));
  for (const id of children) assert.match(body.error, new RegExp(id), 'an agent reading only `error` sees the ids');

  const deleted = await removeChain(root);
  assert.equal(deleted.status, 200);
  assert.equal(((await deleted.json()) as { deleted: string[] }).deleted.length, 4);
  for (const id of [root, ...children]) assert.equal(dbApi.getTask(id), undefined);
});

test('chain deletion keeps every task when one member is still guarded', async () => {
  const { root, children } = seedChain();
  db.prepare("UPDATE tasks SET status = 'IN_PROGRESS' WHERE id = ?").run(children[1]);
  const response = await removeChain(root);
  assert.equal(response.status, 409);
  const body = await response.json() as { code: string; task_id: string };
  assert.equal(body.code, 'task_state');
  assert.equal(body.task_id, children[1]);
  for (const id of [root, ...children]) assert.ok(dbApi.getTask(id));
});

test('chain deletion is refused while a task outside the chain depends on a member', async () => {
  const { root, children } = seedChain();
  const outsider = randomUUID();
  dbApi.createTask(outsider, 'Doc after the chain', 'witness', { deps: [children[2]!], type: 'doc' });
  const response = await removeChain(root);
  assert.equal(response.status, 409);
  const body = await response.json() as { code: string; blockers: { id: string; kind: string }[] };
  assert.equal(body.code, 'task_dependents');
  assert.deepEqual(body.blockers.map((b) => [b.id, b.kind]), [[outsider, 'dep']]);
  for (const id of [root, ...children]) assert.ok(dbApi.getTask(id));
});

test('chain deletion stops on a member the caller may not delete', () => {
  const { root, children } = seedChain();
  const outcome = dbApi.deleteTask(root, { chain: true, canDelete: (t) => t.id !== children[0] });
  assert.equal(outcome.result, 'forbidden');
  assert.equal(outcome.taskId, children[0]);
  for (const id of [root, ...children]) assert.ok(dbApi.getTask(id));
});

test('anonymous chain deletion is denied and an invalid chain flag is a client error', async () => {
  const { root, children } = seedChain();
  assert.equal((await removeChain(root, false)).status, 401);
  const invalid = await fetch(`${base}/api/tasks/${root}?chain=all`, {
    method: 'DELETE', headers: { Authorization: 'Bearer delete-test' },
  });
  assert.equal(invalid.status, 400);
  for (const id of [root, ...children]) assert.ok(dbApi.getTask(id));
});

test('an explicit dependent is named in the refusal', async () => {
  const id = seed('BLOCKED'), dependent = randomUUID();
  dbApi.createTask(dependent, 'Waits on it', 'witness', { deps: [id] });
  const body = await (await remove(id)).json() as { code: string; error: string; blockers: { id: string; title: string }[] };
  assert.equal(body.code, 'task_dependents');
  assert.deepEqual(body.blockers.map((b) => [b.id, b.title]), [[dependent, 'Waits on it']]);
  assert.match(body.error, new RegExp(dependent));
});

test('the task list shows who depends on each task, chain children included', async () => {
  const { root, children } = seedChain();
  const response = await fetch(`${base}/api/tasks?full=1`, { headers: { Authorization: 'Bearer delete-test' } });
  const { tasks } = await response.json() as { tasks: { id: string; dependents: { id: string; kind: string }[] }[] };
  const row = tasks.find((t) => t.id === root);
  assert.ok(row);
  assert.deepEqual(row.dependents.map((d) => [d.id, d.kind]).sort(), children.map((id) => [id, 'chain']).sort());
  const review1 = tasks.find((t) => t.id === children[0]);
  assert.deepEqual(review1?.dependents.map((d) => [d.id, d.kind]), [[children[1], 'dep']]);
});
test('dependency matches are exact and completed missions do not block deletion', async () => {
  const id = seed('BLOCKED'), mission = randomUUID();
  dbApi.createTask(randomUUID(), 'Unrelated dependency', 'witness', { deps: [`${id}-suffix`] });
  dbApi.createMission(mission, 'witness', 'Finished');
  db.prepare("UPDATE missions SET task_id = ?, status = 'done' WHERE id = ?").run(id, mission);
  db.prepare('UPDATE tasks SET mission_id = ? WHERE id = ?').run(mission, id);
  assert.equal((await remove(id)).status, 200);
  assert.ok(dbApi.getMission(mission), 'mission history is preserved');
});
test('a running mission linked only by tasks.mission_id blocks deletion', async () => {
  const id = seed('BLOCKED'), mission = randomUUID();
  dbApi.createMission(mission, 'witness', 'Running');
  db.prepare('UPDATE tasks SET mission_id = ? WHERE id = ?').run(mission, id);
  assert.equal((await remove(id)).status, 409);
  assert.ok(dbApi.getTask(id));
});
