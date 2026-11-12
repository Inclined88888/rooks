/**
 * A mirror task is the inert image of an external ticket: it never runs an
 * agent, and closing it never starts anything. Three ways it could:
 *  - it sits PENDING and the dispatcher picks it up;
 *  - it is closed DONE and the closure chain creates a review / a doc, or the
 *    wake loop sends a return to a pilot;
 *  - it is put back to PENDING by a PUT, or flagged by one.
 */
import '../tests/helpers/no-load-gate.js';
import './test-home.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import express from 'express';
import { db, dbApi } from './db.js';
import { bus } from './bus.js';
import { startDispatcher } from './dispatcher.js';
import { runTaskChain, startTaskChain } from './task-chain.js';
import { handleTaskDone } from './wake.js';
import { eventFromBus } from './triggers/events.js';
import { registerRoutes } from './plugins-bundled/kanban/routes.js';
import { createDaemonAuthMiddleware } from './plugins-bundled/http/auth.js';
import { isMirrorTask } from './task-mirror.js';

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

function seed(opts: { mirror: boolean; type?: 'code' | 'chore'; agent?: string }): string {
  const id = randomUUID();
  dbApi.createTask(id, `${opts.mirror ? 'mirror' : 'real'} task`, opts.agent ?? 'ghost-agent', {
    type: opts.type ?? 'code', mirror: opts.mirror,
  });
  return id;
}

const missionsOf = (agent: string) =>
  (db.prepare('SELECT COUNT(*) AS n FROM missions WHERE agent_name = ?').get(agent) as { n: number }).n;
const tasksCount = () => (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;

test('isMirrorTask reads the flag and nothing else', () => {
  assert.equal(isMirrorTask({ mirror: 1 }), true);
  assert.equal(isMirrorTask({ mirror: 0 }), false);
  assert.equal(isMirrorTask({}), false);
  assert.equal(isMirrorTask(undefined), false);
});

test('a dispatcher tick never runs a PENDING mirror task', async () => {
  const mirror = seed({ mirror: true, agent: 'mirror-agent' });
  const real = seed({ mirror: false, agent: 'real-agent' });
  // The tick logs what it does to a task it picks up; the agent has no
  // directory, so the real task fails to spawn — proof the loop reached it.
  const logged: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => { logged.push(args.join(' ')); originals[level](...args); };
  }
  const stop = startDispatcher(3_600_000);
  try {
    await settle(400);
  } finally {
    stop();
    Object.assign(console, originals);
  }
  // Control: the tick did reach the runnable task…
  assert.ok(logged.some((l) => l.includes(real)), 'the tick looked at the runnable task');
  assert.ok(!logged.some((l) => l.includes(mirror)), 'the tick never looked at the mirror task');
  // …and left the mirror exactly as the plugin wrote it.
  const after = dbApi.getTask(mirror)!;
  assert.equal(after.status, 'PENDING');
  assert.equal(after.mission_id, null);
  assert.equal(missionsOf('mirror-agent'), 0);
});

test('closing a mirror task DONE chains no review, merge or doc and wakes no pilot', async () => {
  const mirror = seed({ mirror: true, agent: 'chain-agent' });
  const before = tasksCount();
  const inbox = () => (db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get() as { n: number }).n;
  const messages = inbox();
  const stop = startTaskChain();
  try {
    dbApi.updateTaskStatus(mirror, 'DONE', { doneComment: 'closed upstream' });
    await settle();
    await runTaskChain(mirror);
    handleTaskDone(mirror);
  } finally { stop(); }
  assert.equal(tasksCount(), before, 'no follow-up task was created');
  assert.equal(inbox(), messages, 'no return was queued for a pilot');
  assert.equal(dbApi.getTask(mirror)?.chain_ran, 2);
  assert.equal(dbApi.listTasksNeedingChain(0, Date.now()).some((t) => t.id === mirror), false);
});

test('a blocked mirror task raises no alert and fires no user trigger', () => {
  const mirror = seed({ mirror: true });
  const seen: string[] = [];
  const onEvent = (ev: { kind: string }) => seen.push(ev.kind);
  bus.on('event', onEvent);
  try { dbApi.updateTaskStatus(mirror, 'BLOCKED', { blockedReason: 'blocked upstream' }); } finally { bus.off('event', onEvent); }
  assert.ok(seen.includes('task_blocked'));
  assert.equal(dbApi.dismissNotificationsByTask(mirror, 'alert'), 0);
  assert.equal(eventFromBus({ kind: 'task_blocked', taskId: mirror, reason: 'x' }), null);
  assert.equal(eventFromBus({ kind: 'task_done', taskId: mirror }), null);
  const real = seed({ mirror: false });
  assert.notEqual(eventFromBus({ kind: 'task_done', taskId: real }), null);
});

const app = express();
app.use(express.json());
app.use(createDaemonAuthMiddleware({ token: 'mirror-test', required: true }));
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const put = (id: string, body: unknown) => fetch(`${base}/api/tasks/${id}`, {
  method: 'PUT', headers: { Authorization: 'Bearer mirror-test', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('putting a mirror task back to PENDING does not make it runnable, and no PUT flips the flag', async () => {
  const mirror = seed({ mirror: true });
  dbApi.updateTaskStatus(mirror, 'BLOCKED', { blockedReason: 'x' });
  // `mirror` is no field of the body: refused outright, nothing written.
  assert.equal((await put(mirror, { status: 'PENDING', mirror: 0 })).status, 400);
  assert.equal(dbApi.getTask(mirror)?.status, 'BLOCKED');
  assert.equal((await put(mirror, { status: 'PENDING' })).status, 200);
  const row = dbApi.getTask(mirror)!;
  assert.equal(row.status, 'PENDING');
  assert.equal(row.mirror, 1);
  assert.equal(dbApi.listPendingReady().some((t) => t.id === mirror), false);

  const real = seed({ mirror: false });
  assert.equal((await put(real, { mirror: 1 })).status, 400);
  assert.equal(dbApi.getTask(real)?.mirror, 0);
});

test('mirror tasks sitting IN_PROGRESS do not fill the parallelism cap', async () => {
  // MAX_PARALLEL is 2 in the test environment: two cards "in progress" elsewhere.
  for (let i = 0; i < 3; i += 1) {
    const mirror = seed({ mirror: true, agent: 'cap-mirror-agent' });
    dbApi.updateTaskStatus(mirror, 'IN_PROGRESS');
  }
  assert.equal(dbApi.countInProgress(), 0);
  const real = seed({ mirror: false, agent: 'cap-real-agent' });
  const logged: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => { logged.push(args.join(' ')); originals[level](...args); };
  }
  const stop = startDispatcher(3_600_000);
  try { await settle(400); } finally { stop(); Object.assign(console, originals); }
  assert.ok(logged.some((l) => l.includes(real)), 'the tick still reached the runnable task');
});
