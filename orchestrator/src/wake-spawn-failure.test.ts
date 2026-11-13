/**
 * A wake spawn that throws must not be retried by every sweep, forever
 * (TIM-0109: 989 failed missions in a day; TIM-0112: 481 in two hours after a
 * team was deleted). Backoff, then give up once with ONE notification; a
 * deleted recipient is never spawned; the owner survives the insertion.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import './test-home.js';
import '../tests/helpers/paid-license.js';
import '../tests/helpers/no-load-gate.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
process.env.ROOKS_WAKE_SWEEP_MS = '100';
await import('../tests/helpers/claude-provider.js');

const { getHost } = await import('./host/index.js');
const { upsertAgent, deleteAgent } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const accounts = await import('./backends/accounts.js');
const { startWake, spawnRetryDelayMs, expediteWakeRetry } = await import('./wake.js');

async function until(check: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ada = createTestAccount(dbApi, { email: 'ada@example.com', name: 'ada', passwordHash: 'x', isSuperadmin: false });
// The only Claude account belongs to a user: a mission without an owner is refused.
const adaAccount = accounts.createBackendAccount({ backend: 'claude', name: 'Ada', ownerUserId: ada.id });

const mkAgent = (name: string, backend = 'claude') => upsertAgent({ name, system_prompt: 'Test agent.',
  config: { cwd: process.env.ROOKS_HOME, backend: backend as 'claude', skills: [], mcp_servers: [], memory_scope: 'NONE' } });

const sourceMission = (owner: string | null, agent = 'wsf-worker') => {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'work', { channel: 'dispatcher' }, owner);
  return id;
};
const taskClosed = (fromMission: string, toAgent: string, over: { owner?: string | null; taskId?: string; status?: string } = {}) =>
  dbApi.enqueueMessage({
    id: randomUUID(), fromMission, fromAgent: 'wsf-worker', toAgent, kind: 'notification',
    ...(over.owner !== undefined ? { ownerUserId: over.owner } : {}),
    payload: JSON.stringify({ kind: 'task_closed', task_id: over.taskId ?? null, task_status: over.status ?? 'DONE', task_type: 'doc' }),
  });

test('backoff doubles from 30 s and stops at 10 min', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(spawnRetryDelayMs),
    [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
});

test('owner NULL + a Claude account that belongs to a user: bounded failures, one notification, no loop', { timeout: 30_000 }, async () => {
  mkAgent('wsf-main', `claude@${adaAccount.id}`);
  mkAgent('wsf-worker');
  const stop = startWake();
  try {
    const alertsBefore = dbApi.listAllInbox({ status: 'pending', limit: 500 })
      .filter((m) => m.from_agent === 'orchestrator' && m.payload.includes('Wake abandoned')).length;
    // Explicit NULL: a system sender with nothing to inherit.
    const msg = taskClosed(sourceMission(null), 'wsf-main', { owner: null });
    const wakes = () => dbApi.listMissions(100, ['wsf-main']).filter((m) => m.source_channel === 'wake');

    await until(() => wakes().length >= 1);
    // Inside the backoff window the sweep (100 ms) must not spawn again.
    await pause(1_000);
    assert.equal(wakes().length, 1, 'no second attempt during the backoff');
    assert.equal(dbApi.getMessage(msg.id)?.status, 'pending');

    // Skip the waits: the ceiling for an account refusal is 3 attempts.
    for (let i = 0; i < 6 && dbApi.getMessage(msg.id)?.status === 'pending'; i++) {
      expediteWakeRetry('wsf-main');
      await pause(400);
    }
    assert.equal(dbApi.getMessage(msg.id)?.status, 'expired');
    assert.equal(wakes().length, 3);

    // Nothing left to retry: more sweeps, no more missions.
    await pause(1_000);
    assert.equal(wakes().length, 3);
    const alerts = dbApi.listAllInbox({ status: 'pending', limit: 500 })
      .filter((m) => m.from_agent === 'orchestrator' && m.payload.includes('Wake abandoned'));
    assert.equal(alerts.length - alertsBefore, 1, 'exactly one notification');
  } finally {
    stop();
  }
});

test('a message for a deleted agent is expired without any spawn', { timeout: 20_000 }, async () => {
  mkAgent('wsf-gone');
  const stop = startWake();
  try {
    deleteAgent('wsf-gone');
    const msg = taskClosed(sourceMission(ada.id), 'wsf-gone');
    await until(() => dbApi.getMessage(msg.id)?.status === 'expired');
    assert.equal(dbApi.listMissions(100, ['wsf-gone']).length, 0);
  } finally {
    stop();
  }
});

test('deleteAgent expires what is waiting in its inbox, but keeps human alerts', () => {
  mkAgent('wsf-doomed');
  const from = sourceMission(ada.id);
  const waiting = taskClosed(from, 'wsf-doomed');
  const alert = dbApi.enqueueMessage({ id: randomUUID(), fromMission: from, fromAgent: 'orchestrator',
    toAgent: 'wsf-doomed', kind: 'notification', payload: '{"kind":"alert","title":"t","body":"b"}' });
  deleteAgent('wsf-doomed');
  assert.equal(dbApi.getMessage(waiting.id)?.status, 'expired');
  assert.equal(dbApi.getMessage(alert.id)?.status, 'pending');
});

test('a message inherits the owner of its sender\'s lineage at insertion', () => {
  const owned = sourceMission(ada.id);
  assert.equal(taskClosed(owned, 'wsf-main').owner_user_id, ada.id);

  // A child mission without owner of its own: the parent's owner stands in.
  const child = randomUUID();
  dbApi.createMission(child, 'wsf-worker', 'sub', { channel: 'dispatcher' });
  dbApi.setMissionLineage(child, { parentMissionId: owned });
  assert.equal(dbApi.getMission(child)?.owner_user_id ?? null, null);
  assert.equal(taskClosed(child, 'wsf-main').owner_user_id, ada.id);

  // Pinned to an owned mission, sent by a system mission.
  const sys = sourceMission(null);
  const pinned = dbApi.enqueueMessage({ id: randomUUID(), fromMission: sys, toMission: owned, fromAgent: 'wsf-worker',
    toAgent: 'wsf-main', kind: 'notification', payload: '{"kind":"task_closed","task_status":"DONE"}' });
  assert.equal(pinned.owner_user_id, ada.id);

  // Explicit NULL is still honoured.
  assert.equal(taskClosed(owned, 'wsf-main', { owner: null }).owner_user_id, null);
});

test('a legacy ownerless return is delivered as the owner of its task, not as a system mission', { timeout: 20_000 }, async () => {
  mkAgent('wsf-pilot', `claude@${adaAccount.id}`);
  const host = getHost();
  const original = host.spawn;
  const children: ChildProcessWithoutNullStreams[] = [];
  host.spawn = ((_cmd, _args, _options) => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 4244;
    child.kill = () => { child.emit('exit', 0); child.emit('close', 0); return true; };
    children.push(child);
    return child;
  }) as typeof host.spawn;
  const stop = startWake();
  try {
    const taskId = randomUUID();
    dbApi.createTask(taskId, 'owned work', 'wsf-worker', { type: 'doc', ownerUserId: ada.id });
    // The row as it exists in a database that predates owner inheritance.
    const msg = taskClosed(sourceMission(null), 'wsf-pilot', { owner: null, taskId, status: 'BLOCKED' });
    await until(() => dbApi.getMessage(msg.id)?.status === 'picked');
    const wake = dbApi.listMissions(100, ['wsf-pilot']).find((m) => m.source_channel === 'wake');
    assert.equal(wake?.owner_user_id, ada.id);
  } finally {
    stop();
    for (const child of children) child.kill();
    host.spawn = original;
  }
});
