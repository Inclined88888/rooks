/**
 * A task that only its backend stopped leaves again once it can, series or not
 * (TODO #520).
 *
 * Before, the series switchover was the only thing that requeued it: a task
 * outside any series, or whose scope refuses every fallback, stayed BLOCKED
 * after its quota had reopened, until a human looked at the board. What these
 * tests pin down: it waits while the backend is sidelined, leaves once the
 * exclusion is lifted or expired, leaves at once on a workable fallback, never
 * touches a business block, and does not loop on a limit that left no
 * exclusion behind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-backend-requeue-test-'));
process.env.ROOKS_FALLBACK_ENABLED = '1';
process.env.ROOKS_FALLBACK_BACKEND = '';
process.env.ROOKS_FALLBACK_MODEL = '';

const { dbApi } = await import('./db.js');
const { mountOfficialProviders, stubCliBinaries } = await import('../tests/helpers/official-providers.js');
await stubCliBinaries('grok', 'codex');
await mountOfficialProviders();
const { clearBackendCooldown } = await import('./backend-fallback.js');
const { requeueBackendBlockedTasks, resetBackendRequeues } = await import('./dispatcher.js');
const { REQUEUE_BACKOFF_BASE_MS } = await import('./interruption.js');

const HOUR = 3600_000;

/** A task outside any series, on grok, that its backend stopped. `none` as its
 *  fallback: only a reopening can move it. */
function blockedTask(
  reason: 'rate_limit' | 'exhausted' | 'backend_unavailable' = 'rate_limit',
  fallback: string = 'none',
): string {
  const id = randomUUID();
  dbApi.createTask(id, `task ${reason}`, 'p.coder', {
    type: 'code',
    backendOverride: 'grok',
    modelOverride: 'grok-4.6',
    fallbackBackendOverride: fallback,
  });
  dbApi.setTaskInterrupted(id, reason, `Mission interrupted (${reason})`);
  assert.equal(dbApi.getTask(id)?.status, 'BLOCKED');
  return id;
}

/** Long after the block: the backoff never stands in the way. */
const later = (): number => Date.now() + HOUR;

function reset(): void {
  resetBackendRequeues();
  clearBackendCooldown('grok');
  clearBackendCooldown('codex');
  for (const t of dbApi.listTasks('BLOCKED')) dbApi.updateTaskStatus(t.id, 'DONE', {});
}

test('a task waits while its backend is sidelined, and leaves once the quota reopens', () => {
  reset();
  dbApi.setBackendCooldown('grok', Date.now() + 5 * HOUR, 'five_hour', true, 'rate_limit');
  const id = blockedTask();

  assert.equal(requeueBackendBlockedTasks(later()), 0);
  assert.equal(dbApi.getTask(id)?.status, 'BLOCKED');

  // What the usage sweep (or a successful turn elsewhere) does when the window
  // reopens early. Before the fix, nothing followed it.
  clearBackendCooldown('grok');
  assert.equal(requeueBackendBlockedTasks(later()), 1);

  const task = dbApi.getTask(id);
  assert.equal(task?.status, 'PENDING');
  assert.equal(task?.interrupted_reason, null);
  assert.equal(task?.blocked_reason, null);
  assert.equal(task?.mission_id, null);
  // A quota outage is not a crash: it must not eat the crash-loop budget.
  assert.equal(task?.requeue_count, 0);
});

test('an exclusion past its time is enough: the task leaves without anyone lifting it', () => {
  reset();
  const id = blockedTask('exhausted');
  dbApi.setBackendCooldown('grok', Date.now() - 1000, 'balance exhausted', false, 'exhausted');

  assert.equal(requeueBackendBlockedTasks(later()), 1);
  assert.equal(dbApi.getTask(id)?.status, 'PENDING');
  assert.equal(dbApi.getBackendCooldown('grok'), undefined);
});

test('a circuit-breaker block leaves too, once the backend is back', () => {
  reset();
  dbApi.setBackendCooldown('grok', Date.now() + 30 * 60_000, 'circuit breaker', false, 'unavailable');
  const id = blockedTask('backend_unavailable');

  assert.equal(requeueBackendBlockedTasks(later()), 0);
  clearBackendCooldown('grok');
  assert.equal(requeueBackendBlockedTasks(later()), 1);
  assert.equal(dbApi.getTask(id)?.status, 'PENDING');
});

test('a backend still sidelined but with a workable fallback lets the task leave now', () => {
  reset();
  dbApi.setBackendCooldown('grok', Date.now() + 5 * HOUR, 'five_hour', true, 'rate_limit');
  const id = blockedTask('rate_limit', 'codex');

  assert.equal(requeueBackendBlockedTasks(later()), 1);
  // The redirect itself belongs to the spawn (`redirectIfStillDry`), like for
  // any PENDING task: nothing is carved on the task here.
  const task = dbApi.getTask(id);
  assert.equal(task?.status, 'PENDING');
  assert.equal(task?.backend_override, 'grok');
});

test('a series whose scope refuses every fallback waits for the reopening, then leaves', () => {
  reset();
  dbApi.setBackendCooldown('grok', Date.now() + 5 * HOUR, 'five_hour', true, 'rate_limit');
  const seriesId = randomUUID();
  // `--backend none`: this series would rather stop than continue elsewhere.
  // The switchover leaves such a task BLOCKED, and before the fix nothing
  // ever picked it up again.
  dbApi.setSeriesFallback(seriesId, 'code', null, null);
  const id = randomUUID();
  dbApi.createTask(id, 'series volet', 'p.coder', {
    type: 'code', seriesId, backendOverride: 'grok', modelOverride: 'grok-4.6',
  });
  dbApi.setTaskInterrupted(id, 'rate_limit', 'Mission interrupted (rate_limit)');

  assert.equal(requeueBackendBlockedTasks(later()), 0);
  assert.equal(dbApi.getTask(id)?.status, 'BLOCKED');

  clearBackendCooldown('grok');
  assert.equal(requeueBackendBlockedTasks(later()), 1);
  assert.equal(dbApi.getTask(id)?.status, 'PENDING');
});

test('the backend judged is the one the next spawn uses, not the dead mission’s', () => {
  reset();
  dbApi.setBackendCooldown('grok', Date.now() + 5 * HOUR, 'five_hour', true, 'rate_limit');
  const id = blockedTask();
  // Repointed by hand onto a backend that has quota: waiting for grok would be
  // waiting for nothing.
  dbApi.updateTask(id, { backendOverride: 'codex', modelOverride: null });

  assert.equal(requeueBackendBlockedTasks(later()), 1);
  assert.equal(dbApi.getTask(id)?.status, 'PENDING');
});

test('a business block is never touched, whatever the backend says', () => {
  reset();
  const id = randomUUID();
  dbApi.createTask(id, 'blocked by its agent', 'p.coder', { type: 'code', backendOverride: 'grok' });
  dbApi.updateTaskStatus(id, 'BLOCKED', { blockedReason: 'waiting for a decision' });

  assert.equal(requeueBackendBlockedTasks(later()), 0);
  assert.equal(dbApi.getTask(id)?.status, 'BLOCKED');
});

test('nor a death that says something about the task', () => {
  reset();
  const id = randomUUID();
  dbApi.createTask(id, 'permission refused', 'p.coder', { type: 'code', backendOverride: 'grok' });
  dbApi.setTaskInterrupted(id, 'permission_denied', 'Mission interrupted (permission_denied)');

  assert.equal(requeueBackendBlockedTasks(later()), 0);
  assert.equal(dbApi.getTask(id)?.status, 'BLOCKED');
});

test('a limit that left no exclusion behind is retried with a growing delay, not every tick', () => {
  reset();
  const id = blockedTask();
  const blockedAt = dbApi.getTask(id)!.updated_at;

  // Just blocked: the first try waits the base delay.
  assert.equal(requeueBackendBlockedTasks(blockedAt + 1000), 0);
  assert.equal(requeueBackendBlockedTasks(blockedAt + REQUEUE_BACKOFF_BASE_MS), 1);

  // The same limit stops it again, still without an exclusion.
  dbApi.setTaskInterrupted(id, 'rate_limit', 'Mission interrupted (rate_limit)');
  const again = dbApi.getTask(id)!.updated_at;
  assert.equal(requeueBackendBlockedTasks(again + REQUEUE_BACKOFF_BASE_MS), 0);
  assert.equal(requeueBackendBlockedTasks(again + 2 * REQUEUE_BACKOFF_BASE_MS), 1);
});
