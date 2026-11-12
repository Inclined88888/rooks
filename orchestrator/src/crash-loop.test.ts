/**
 * TIM-0065 — a task whose mission keeps dying must stop, not spin forever.
 *
 * The automatic requeues were already capped. The loop that remained went
 * through the pilot: woken by the escalation, it set the task back to PENDING,
 * the dispatcher replayed it at once, the mission died the same way, and the
 * pilot was woken again — with nothing in the database counting the turns.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-crash-loop-'));
await import('../tests/helpers/paid-license.js');
await import('../tests/helpers/claude-provider.js');

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { dbApi, MAX_SYSTEM_REQUEUES, CRASH_LOOP_HARD_CEILING } = await import('./db.js');
const { bus } = await import('./bus.js');
const { agentDir } = await import('./paths.js');
const { issueMissionApiToken } = await import('./users/api-tokens.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerRoutes: kanban } = await import('./plugins-bundled/kanban/routes.js');
const { watchMissionComplete, lastMissionError } = await import('./dispatcher.js');
const { REQUEUE_BACKOFF_BASE_MS } = await import('./interruption.js');

const OPERATOR = 'crash-loop-operator-token';
for (const [name, config] of Object.entries({
  pilot: { role: 'orchestrator', orchestrates: '*' },
  worker: {},
  'worker.alt': {},
})) {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'system-prompt.md'), 'test');
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ cwd: process.env.ROOKS_HOME, ...config }));
}
const owner = createTestAccount(dbApi, { email: 'owner@example.test', name: 'Owner', passwordHash: 'x', isSuperadmin: true });
const pilotMission = randomUUID();
dbApi.createMission(pilotMission, 'pilot', 'orchestrates the series', undefined, owner.id);
const PILOT = issueMissionApiToken(pilotMission);

const app = express();
app.use(createDaemonAuthMiddleware({ token: OPERATOR, required: true }));
app.use(express.json());
kanban(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

function put(id: string, body: Record<string, unknown>, bearer: string) {
  return fetch(`${base}/api/tasks/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
}

function newTask(): string {
  const id = randomUUID();
  dbApi.createTask(id, `task ${id.slice(0, 8)}`, 'worker', { type: 'chore', ownerUserId: owner.id });
  return id;
}

/** The dispatcher picks the task up: a fresh mission, IN_PROGRESS. */
function dispatch(id: string): string {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'worker', 'attempt', undefined, owner.id);
  dbApi.assignTaskMission(id, missionId);
  return missionId;
}

/** Dies `n` times in a row, replayed by the automatic requeue in between. */
function dieUntilBlocked(id: string, reason: 'crash' | 'unknown' = 'crash'): void {
  for (;;) {
    dispatch(id);
    const outcome = dbApi.setTaskInterrupted(id, reason, 'mission died');
    if (outcome !== 'requeued') return;
  }
}

test('a death past the cap is still counted, so the database knows the loop', () => {
  const id = newTask();
  dieUntilBlocked(id);
  assert.equal(dbApi.getTask(id)?.status, 'BLOCKED');
  assert.equal(dbApi.getTask(id)?.requeue_count, MAX_SYSTEM_REQUEUES + 1);
  // Requeued by hand and dead again: one more, where the count used to freeze.
  dbApi.updateTaskStatus(id, 'PENDING');
  dispatch(id);
  assert.equal(dbApi.setTaskInterrupted(id, 'crash', 'again'), 'escalated');
  assert.equal(dbApi.getTask(id)?.requeue_count, MAX_SYSTEM_REQUEUES + 2);
});

test('a backend outage or a human stop never counts toward a crash loop', () => {
  for (const reason of ['rate_limit', 'exhausted', 'backend_unavailable', 'stopped'] as const) {
    const id = newTask();
    dispatch(id);
    assert.equal(dbApi.setTaskInterrupted(id, reason, 'not the task'), 'blocked');
    assert.equal(dbApi.getTask(id)?.requeue_count, 0, reason);
  }
});

test('the pilot cannot replay an exhausted task unchanged: 409, it stays BLOCKED', async () => {
  const id = newTask();
  dieUntilBlocked(id);
  const r = await put(id, { status: 'PENDING' }, PILOT);
  assert.equal(r.status, 409);
  const body = await r.json() as { code: string; error: string };
  assert.equal(body.code, 'crash_loop');
  assert.match(body.error, /agent, backend or model/);
  assert.equal(dbApi.getTask(id)?.status, 'BLOCKED');
});

test('the pilot may requeue a corrected task, after a backoff, until the hard ceiling', async () => {
  const id = newTask();
  dieUntilBlocked(id);
  const before = Date.now();
  const r = await put(id, { status: 'PENDING', agent_name: 'worker.alt', scheduled_at: before }, PILOT);
  assert.equal(r.status, 200);
  const task = dbApi.getTask(id);
  assert.equal(task?.status, 'PENDING');
  assert.ok((task?.scheduled_at ?? 0) >= before + REQUEUE_BACKOFF_BASE_MS, 'replayed at once, not after a backoff');
  assert.ok(!dbApi.listPendingReady().some((t) => t.id === id), 'the dispatcher must not see it yet');

  // Every later death past the ceiling closes the agent path, correction or not.
  let alt = 'worker';
  for (let deaths = task?.requeue_count ?? 0; deaths < CRASH_LOOP_HARD_CEILING;) {
    dispatch(id);
    dbApi.setTaskInterrupted(id, 'crash', 'dies on the other agent too');
    deaths = dbApi.getTask(id)?.requeue_count ?? 0;
    if (deaths >= CRASH_LOOP_HARD_CEILING) break;
    assert.equal((await put(id, { status: 'PENDING', agent_name: alt }, PILOT)).status, 200);
    alt = alt === 'worker' ? 'worker.alt' : 'worker';
  }
  const refused = await put(id, { status: 'PENDING', agent_name: alt }, PILOT);
  assert.equal(refused.status, 409);
  assert.match((await refused.json() as { error: string }).error, /Only a human/);
});

test('clearing an override is a correction, and the update really clears it', async () => {
  for (const key of ['backend_override', 'model_override'] as const) {
    const id = randomUUID();
    dbApi.createTask(id, `pinned ${key}`, 'worker', {
      type: 'chore', ownerUserId: owner.id, backendOverride: 'claude', modelOverride: 'opus',
    });
    dieUntilBlocked(id);
    const r = await put(id, { status: 'PENDING', [key]: null }, PILOT);
    assert.equal(r.status, 200, key);
    const task = dbApi.getTask(id);
    assert.equal(task?.status, 'PENDING', key);
    assert.equal(task?.[key], null, `${key} accepted as a correction but still in the database`);
    // The override left out of the body is kept.
    const other = key === 'backend_override' ? 'model_override' : 'backend_override';
    assert.equal(task?.[other], key === 'backend_override' ? 'opus' : 'claude', other);
  }
});

test('clearing an override the task does not carry is no correction', async () => {
  const id = newTask();
  dieUntilBlocked(id);
  for (const body of [
    { backend_override: null, model_override: null },
    { model_override: '' },
  ]) {
    const r = await put(id, { status: 'PENDING', ...body }, PILOT);
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.equal(dbApi.getTask(id)?.status, 'BLOCKED');
    assert.equal(dbApi.getTask(id)?.model_override, null);
  }
});

test('a death that is never replayed automatically loops no more than a crash', async () => {
  // `unknown` blocks at once without requeue: before, it counted nothing at all.
  const id = newTask();
  for (let i = 1; i < MAX_SYSTEM_REQUEUES; i++) {
    dispatch(id);
    assert.equal(dbApi.setTaskInterrupted(id, 'unknown', 'no idea'), 'blocked');
    assert.equal((await put(id, { status: 'PENDING' }, PILOT)).status, 200);
  }
  dispatch(id);
  dbApi.setTaskInterrupted(id, 'unknown', 'no idea');
  assert.equal((await put(id, { status: 'PENDING' }, PILOT)).status, 409);
});

test('a human restart is a fresh start: no refusal, no backoff, count cleared', async () => {
  const id = newTask();
  dieUntilBlocked(id);
  for (let i = 0; i < CRASH_LOOP_HARD_CEILING; i++) {
    dbApi.updateTaskStatus(id, 'PENDING');
    dispatch(id);
    dbApi.setTaskInterrupted(id, 'crash', 'still dying');
  }
  const scheduledBefore = dbApi.getTask(id)?.scheduled_at ?? null;
  const r = await put(id, { status: 'PENDING' }, OPERATOR);
  assert.equal(r.status, 200);
  const task = dbApi.getTask(id);
  assert.equal(task?.status, 'PENDING');
  assert.equal(task?.requeue_count, 0);
  // Only the automatic backoffs of the deaths above, all instantaneous here.
  assert.equal(task?.scheduled_at ?? null, scheduledBefore, 'a human retry is not held back');
});

test('the blocked reason carries what the backend said before dying', () => {
  const stop = watchMissionComplete();
  try {
    const id = newTask();
    // Past the cap, so the death blocks instead of requeuing.
    dieUntilBlocked(id);
    dbApi.updateTaskStatus(id, 'PENDING', { blockedReason: null });
    const missionId = dispatch(id);
    dbApi.insertEvent(missionId, 'backend_failed', {
      type: 'backend_failed', backend: 'claude', exitCode: 1, missionId, sessionId: null,
      stderr: 'Error: connect ECONNREFUSED 127.0.0.1:443',
    });
    assert.match(lastMissionError(missionId) ?? '', /code 1\): Error: connect ECONNREFUSED/);
    bus.publish({ kind: 'mission_complete', missionId, status: 'failed', exitCode: 1 });
    const task = dbApi.getTask(id);
    assert.equal(task?.status, 'BLOCKED');
    assert.match(task?.blocked_reason ?? '', /Last error: the backend exited \(code 1\): Error: connect ECONNREFUSED/);
  } finally { stop(); }
});

test('a sign-in failure is read from the CLI\'s error-coded message, never from the model', () => {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'worker', 'attempt', undefined, owner.id);
  dbApi.insertEvent(missionId, 'assistant', {
    type: 'assistant', message: { content: [{ type: 'text', text: 'I will sign in again later.' }] },
  });
  assert.equal(lastMissionError(missionId), null, 'a model sentence is not an error');
  dbApi.insertEvent(missionId, 'assistant', {
    type: 'assistant', error: 'authentication_failed',
    message: { model: '<synthetic>', content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired' }] },
  });
  assert.equal(lastMissionError(missionId), 'the backend reported authentication_failed: Failed to authenticate: OAuth session expired');
});

test('a CLI that could not start is named, not described as a crash', () => {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'worker', 'attempt', undefined, owner.id);
  dbApi.insertEvent(missionId, 'spawn_failed', { type: 'spawn_failed', backend: 'claude', binary: 'claude', cause: 'missing' });
  assert.equal(lastMissionError(missionId), 'the claude CLI could not start (missing).');
  assert.equal(lastMissionError(randomUUID()), null);
});
