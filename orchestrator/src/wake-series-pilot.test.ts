/**
 * A series' work returns reach the mission piloting the series, even when the
 * return is addressed to another orchestrator agent.
 *
 * Incident of 2026-10-01 (series 87eb4eca): doc tasks run by `ROOKS.librarian`
 * carry no project on purpose (it serves every project from the vault), so
 * the dispatcher stamped their missions with `parent_agent = _main` while the
 * series was piloted by a `rooks.main` mission. `seriesPilotOf` dropped the
 * pilot on the agent mismatch, every return spawned a fresh wake mission that
 * adopted the series, and the next return — addressed to the other agent —
 * did the same in reverse: 14 wake missions alternating `_main` / `rooks.main`.
 *
 * The lineage is stamped by hand (`parent_agent: '_main'`) so these tests
 * isolate the wake-loop guard from the dispatcher fix: they must stay green
 * for missions dispatched before it, which still carry the wrong agent.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import './test-home.js';
import '../tests/helpers/paid-license.js';
import '../tests/helpers/no-load-gate.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
const { getHost } = await import('./host/index.js');
await import('../tests/helpers/claude-provider.js');

const { spawnAgent, upsertAgent } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { startWake } = await import('./wake.js');

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

for (const name of ['rooks.main', '_main', 'ROOKS.librarian', 'ext.reviewer']) {
  upsertAgent({
    name,
    system_prompt: 'Test agent.',
    config: { cwd: process.env.ROOKS_HOME, backend: 'claude', skills: [], mcp_servers: [], memory_scope: 'NONE' },
  });
}

type Harness = {
  children: Map<string, ChildProcessWithoutNullStreams>;
  emit: (missionId: string, event: unknown) => void;
  restore: () => void;
};

function fakeHost(): Harness {
  const host = getHost();
  const original = host.spawn;
  const children = new Map<string, ChildProcessWithoutNullStreams>();
  host.spawn = ((_cmd, _args, options) => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 4242;
    child.kill = () => { child.emit('exit', 0); child.emit('close', 0); return true; };
    children.set(String(options?.env?.ROOKS_MISSION_ID), child);
    return child;
  }) as typeof host.spawn;
  return {
    children,
    emit: (missionId, event) => children.get(missionId)!.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n')),
    restore: () => {
      for (const child of children.values()) child.kill();
      host.spawn = original;
    },
  };
}

/** A `rooks.main` pilot whose turn is over (idle, resumable), the task it
 *  launched, and a task mission stamped with the stale `_main` lineage. */
async function seriesWithStaleLineage(
  h: Harness,
  type: 'doc' | 'review',
  agent: string,
  resumable = true,
  ownerUserId: string | null = null,
) {
  const pilot = await spawnAgent('rooks.main', 'Plan the series.', undefined, { ownerUserId });
  if (resumable) h.emit(pilot, { type: 'system', subtype: 'init', session_id: `pilot-${pilot}` });
  h.emit(pilot, { type: 'result', subtype: 'success', is_error: false, result: 'Tasks queued.' });

  const taskId = randomUUID();
  dbApi.createTask(taskId, `${type} of the series`, agent, { type, creatorMissionId: pilot });
  // A sibling still pending: `remapSeriesOrchestratorMission` only moves
  // unfinished tasks, this is the one a stolen helm would repoint.
  const sibling = randomUUID();
  dbApi.createTask(sibling, 'next step of the series', 'ext.reviewer', { type: 'code', creatorMissionId: pilot });

  const missionId = randomUUID();
  dbApi.createMission(missionId, agent, `${type} of the series`, { channel: 'dispatcher' }, ownerUserId);
  dbApi.assignTaskMission(taskId, missionId);
  dbApi.setMissionLineage(missionId, { parentMissionId: pilot, parentAgent: '_main', taskId });
  return { pilot, taskId, sibling, pilots: dbApi.listMissions(50, ['rooks.main']).length };
}

function deliveredInto(missionId: string, needle: string): boolean {
  return dbApi.listEvents(missionId)
    .filter((e) => e.type === 'user')
    .some((e) => e.payload.includes(needle));
}

async function assertNoPingPong(
  run: () => void,
  setup: { pilot: string; sibling: string; pilots: number },
  needle: string,
): Promise<void> {
  const remaps: string[] = [];
  const realRemap = dbApi.remapSeriesOrchestratorMission;
  dbApi.remapSeriesOrchestratorMission = (seriesId, oldId, newId) => {
    remaps.push(`${seriesId}:${oldId}->${newId}`);
    return realRemap.call(dbApi, seriesId, oldId, newId);
  };
  const wakesBefore = dbApi.listMissions(50, ['_main']).length;
  const stop = startWake();
  try {
    run();
    await until(
      () => deliveredInto(setup.pilot, needle) || dbApi.listMissions(50, ['_main']).length > wakesBefore,
      'the return to be delivered or a wake to be spawned',
    );
    // Let a racing flush finish before judging what it did.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(dbApi.listMissions(50, ['_main']).length, wakesBefore, 'no wake mission may be spawned for _main');
    assert.equal(dbApi.listMissions(50, ['rooks.main']).length, setup.pilots, 'the pilot is reused, not forked');
    assert.ok(deliveredInto(setup.pilot, needle), 'the return lands in the pilot mission');
    assert.deepEqual(remaps, [], 'the series keeps its pilot');
    assert.equal(dbApi.getTask(setup.sibling)?.creator_mission_id, setup.pilot);
    const pending = dbApi.listInbox('_main', { status: 'pending', limit: 50 });
    assert.equal(pending.length, 0, 'nothing is left waiting in _main inbox');
  } finally {
    stop();
    dbApi.remapSeriesOrchestratorMission = realRemap;
  }
}

test('a blocked doc task of the librarian reaches the rooks.main pilot, not a _main wake', { timeout: 20000 }, async () => {
  const h = fakeHost();
  try {
    const setup = await seriesWithStaleLineage(h, 'doc', 'ROOKS.librarian');
    await assertNoPingPong(
      () => dbApi.updateTaskStatus(setup.taskId, 'BLOCKED', { blockedReason: 'vault note locked by sync' }),
      setup,
      'vault note locked by sync',
    );
  } finally { h.restore(); }
});

test('the same holds for a series owned by a user', { timeout: 20000 }, async () => {
  const h = fakeHost();
  try {
    const owner = createTestAccount(dbApi, { email: 'pilot-owner@example.test', name: 'Owner', passwordHash: 'x' });
    const setup = await seriesWithStaleLineage(h, 'doc', 'ROOKS.librarian', true, owner.id);
    assert.equal(dbApi.getTask(setup.taskId)?.owner_user_id, owner.id);
    await assertNoPingPong(
      () => dbApi.updateTaskStatus(setup.taskId, 'BLOCKED', { blockedReason: 'owned vault note locked' }),
      setup,
      'owned vault note locked',
    );
  } finally { h.restore(); }
});

test('a closed task return addressed to another orchestrator reaches the series pilot', { timeout: 20000 }, async () => {
  const h = fakeHost();
  try {
    const setup = await seriesWithStaleLineage(h, 'review', 'ext.reviewer');
    // A verdict other than `pass` always calls for a decision: the return is urgent.
    await assertNoPingPong(
      () => dbApi.updateTaskStatus(setup.taskId, 'DONE', { doneComment: 'verdict: changes_requested\n- missing null check' }),
      setup,
      'missing null check',
    );
  } finally { h.restore(); }
});

test('a request an agent sends from a task mission is never redirected to the series pilot', { timeout: 20000 }, async () => {
  const h = fakeHost();
  const stop = startWake();
  try {
    const setup = await seriesWithStaleLineage(h, 'review', 'ext.reviewer');
    const from = dbApi.getTask(setup.taskId)!.mission_id!;
    const wakesBefore = dbApi.listMissions(50, ['_main']).length;
    const request = dbApi.enqueueMessage({ id: randomUUID(), fromMission: from, fromAgent: 'ext.reviewer',
      toAgent: '_main', kind: 'request', payload: 'Which branch is the base of this series?' });
    await until(() => dbApi.getMessage(request.id)?.status === 'picked', 'the request to be picked');
    assert.equal(dbApi.listMissions(50, ['_main']).length, wakesBefore + 1, 'the addressee answers it');
    assert.ok(!deliveredInto(setup.pilot, 'Which branch is the base'), 'the pilot never sees it');
    assert.equal(dbApi.getTask(setup.sibling)?.creator_mission_id, setup.pilot, 'answering it does not take the helm');
  } finally {
    stop();
    h.restore();
  }
});

test('a pilot that cannot be resumed still hands the series to the wake mission', { timeout: 20000 }, async () => {
  const h = fakeHost();
  const remaps: string[] = [];
  const realRemap = dbApi.remapSeriesOrchestratorMission;
  dbApi.remapSeriesOrchestratorMission = (seriesId, oldId, newId) => {
    remaps.push(newId);
    return realRemap.call(dbApi, seriesId, oldId, newId);
  };
  const stop = startWake();
  try {
    // No session: the pilot cannot be resurrected in place.
    const setup = await seriesWithStaleLineage(h, 'doc', 'ROOKS.librarian', false);
    const wakesBefore = dbApi.listMissions(50, ['_main']).length;
    dbApi.updateTaskStatus(setup.taskId, 'BLOCKED', { blockedReason: 'vault offline' });
    await until(() => dbApi.listMissions(50, ['_main']).length > wakesBefore, 'a wake mission');
    await until(() => remaps.length > 0, 'the series to be adopted');
    const wake = dbApi.listMissions(50, ['_main'])[0]!.id;
    assert.deepEqual(remaps, [wake]);
    assert.equal(dbApi.getTask(setup.sibling)?.creator_mission_id, wake);
    assert.ok(!deliveredInto(setup.pilot, 'vault offline'));
  } finally {
    stop();
    dbApi.remapSeriesOrchestratorMission = realRemap;
    h.restore();
  }
});
