/**
 * A model at capacity moves the task onto its fallback plan.
 *
 * Replays the morning of 05/10/2026 end to end: the codex `result` persisted for
 * the three dead reviews, the autopsy (`finishMission`), the requeue, and the
 * dispatcher's switch. Before the fix the same payload read as `crash`: three
 * replays into the full model, then BLOCKED.
 *
 * `npm test -- src/overloaded-fallback-chain.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-overloaded-chain-test-'));
process.env.TIMON_FALLBACK_ENABLED = '1';

const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
const { watchMissionComplete } = await import('./dispatcher.js');

const OVERLOADED_RESULT = {
  type: 'result',
  subtype: 'error',
  is_error: true,
  error: 'Selected model is at capacity. Please try a different model.',
  total_cost_usd: 0,
};

function dieOverloaded(taskId: string): string | null {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'p.reviewer', 'review');
  dbApi.assignTaskMission(taskId, missionId);
  dbApi.insertEvent(missionId, 'result', OVERLOADED_RESULT);
  const effective = dbApi.finishMission(missionId, 'failed', 1, 'crash');
  bus.publish({ kind: 'mission_complete', missionId, status: 'failed', exitCode: 1, reason: effective });
  return effective;
}

{
  const { mountOfficialProviders, stubCliBinaries, stubCodexSignIn } = await import('../tests/helpers/official-providers.js');
  // A fallback goes only to a CLI that is on this host and signed in: stand-ins, never the machine's own.
  await stubCliBinaries('claude', 'codex');
  await stubCodexSignIn();
  await mountOfficialProviders();
}

test('the codex payload reads as overloaded and the task leaves on its fallback, now', () => {
  const stop = watchMissionComplete();
  try {
    const taskId = randomUUID();
    dbApi.createTask(taskId, 'review iter:1', 'p.reviewer', {
      type: 'review',
      backendOverride: 'codex', modelOverride: 'gpt-5.6-sol',
      fallbackBackendOverride: 'claude', fallbackModelOverride: 'opus',
    });
    assert.equal(dieOverloaded(taskId), 'overloaded', 'a full model must not read as a crash');

    const t = dbApi.getTask(taskId);
    assert.equal(t?.status, 'PENDING');
    assert.equal(t?.backend_override, 'claude');
    assert.equal(t?.model_override, 'opus');
    // Released now: the backoff was for the model that is full, not for this one.
    assert.equal(t?.scheduled_at, null);
    assert.equal(t?.interrupted_reason, null);
    // No backend-wide exclusion: codex's other models and the account are fine.
    assert.equal(dbApi.getBackendCooldown('codex'), undefined);
  } finally {
    stop();
  }
});

test('with no workable fallback the task keeps its backend and waits out the backoff', () => {
  const stop = watchMissionComplete();
  try {
    const taskId = randomUUID();
    dbApi.createTask(taskId, 'review iter:1', 'p.reviewer', {
      type: 'review',
      backendOverride: 'codex', modelOverride: 'gpt-5.6-sol',
      // The task's explicit refusal of any fallback.
      fallbackBackendOverride: 'none',
    });
    const before = Date.now();
    assert.equal(dieOverloaded(taskId), 'overloaded');

    const t = dbApi.getTask(taskId);
    assert.equal(t?.status, 'PENDING');
    assert.equal(t?.backend_override, 'codex');
    assert.equal(t?.model_override, 'gpt-5.6-sol');
    assert.ok((t?.scheduled_at ?? 0) > before, 'the requeue backoff stays in place');
    assert.equal(t?.requeue_count, 1);
  } finally {
    stop();
  }
});
