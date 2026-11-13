/**
 * A `changes_requested` review always yields its repair iteration (TODO #322).
 *
 * Incident of 2026-10-12: review da2cae59 closed `changes_requested`, the chain
 * ran to CHAIN_DONE and created nothing, with no log line — a `code` task of the
 * series that depended on the review had been taken for the repair
 * (`hasChildTask`). Covered here: that task is not an iteration, the exits of
 * `handleReviewDone` no longer end the chain silently, and the reconcile
 * catches what was already lost.
 *
 * `npm test -- src/verification-repair.test.ts`
 */
import '../tests/helpers/no-load-gate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-verif-repair-test-'));
const { dbApi, db, CHAIN_DONE, CHAIN_NEVER } = await import('./db.js');
const { runTaskChain } = await import('./task-chain.js');
const {
  reconcileMissingChangesRequested,
  VERIFICATION_MAX_ITERATIONS,
} = await import('./verification-loop.js');

type Type = 'code' | 'review' | 'merge' | 'chore';

function mkTask(type: Type, deps: string[] = []): string {
  const id = randomUUID();
  dbApi.createTask(id, `${type} — volet`, 'p.coder', { type, deps });
  return id;
}

/** Code root DONE + review at `iteration` closed with the given verdict. */
function mkChain(comment: string, iteration = 1): { rootId: string; reviewId: string } {
  const rootId = mkTask('code');
  dbApi.updateTaskStatus(rootId, 'DONE', { doneComment: 'code done' });
  const reviewId = mkTask('review', [rootId]);
  dbApi.setTaskVerificationMeta(reviewId, iteration, rootId);
  dbApi.updateTaskStatus(reviewId, 'DONE', { doneComment: comment });
  return { rootId, reviewId };
}

const CR = 'verdict: changes_requested\n\n- point en prose, sans JSON';

function iterationsOf(rootId: string, iteration: number): string[] {
  return dbApi
    .listTasksByVerificationRoot(rootId)
    .filter((t) => t.type === 'code' && t.iteration === iteration)
    .map((t) => t.id);
}

test('series code task depending on the review is NOT the repair: iteration N+1 is created', async () => {
  const { rootId, reviewId } = mkChain(CR);
  const seriesTask = mkTask('code', [reviewId]);
  await runTaskChain(reviewId);
  const iter = iterationsOf(rootId, 2);
  assert.equal(iter.length, 1);
  assert.notEqual(iter[0], seriesTask);
  assert.equal(dbApi.isTaskChainRan(reviewId), true);
  // The series task stays what it was: untagged, untouched.
  assert.equal(dbApi.getTask(seriesTask)?.verification_root_id, null);
});

test('an existing iteration N+1 of the chain is not duplicated, whoever depends on what', async () => {
  const { rootId, reviewId } = mkChain(CR);
  await runTaskChain(reviewId);
  assert.equal(iterationsOf(rootId, 2).length, 1);
  // A second review of the same iteration (concurrent) must not fork a twin.
  const twin = mkTask('review', [rootId]);
  dbApi.setTaskVerificationMeta(twin, 1, rootId);
  dbApi.updateTaskStatus(twin, 'DONE', { doneComment: CR });
  await runTaskChain(twin);
  assert.equal(iterationsOf(rootId, 2).length, 1);
});

test('chain root gone → the chain is not marked DONE (replayable, then escalated)', async () => {
  const reviewId = mkTask('review');
  dbApi.setTaskVerificationMeta(reviewId, 1, randomUUID());
  dbApi.updateTaskStatus(reviewId, 'DONE', { doneComment: CR });
  await assert.rejects(runTaskChain(reviewId), /no longer exists/);
  assert.equal(dbApi.getTask(reviewId)?.chain_ran, CHAIN_NEVER);
});

test('reconcile: a changes_requested review chained DONE without iteration gets it, once', async () => {
  const { rootId, reviewId } = mkChain(CR);
  mkTask('code', [reviewId]); // the series task of the incident
  dbApi.setTaskChainState(reviewId, CHAIN_DONE); // chain "finished", nothing created
  assert.equal(iterationsOf(rootId, 2).length, 0);
  await reconcileMissingChangesRequested();
  assert.equal(iterationsOf(rootId, 2).length, 1);
  await reconcileMissingChangesRequested();
  assert.equal(iterationsOf(rootId, 2).length, 1, 'idempotent');
});

test('reconcile respects the iteration cap and leaves the root alone', async () => {
  const { rootId, reviewId } = mkChain(CR, VERIFICATION_MAX_ITERATIONS);
  await reconcileMissingChangesRequested();
  assert.equal(iterationsOf(rootId, VERIFICATION_MAX_ITERATIONS + 1).length, 0);
  assert.notEqual(dbApi.getTask(rootId)?.status, 'BLOCKED');
  assert.ok(reviewId);
});

test('reconcile skips a pass review, a BLOCKED root and reviews older than 6 h', async () => {
  const pass = mkChain('verdict: pass');
  const blocked = mkChain(CR);
  dbApi.updateTaskStatus(blocked.rootId, 'BLOCKED', { blockedReason: 'abandoned by hand' });
  const old = mkChain(CR);
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now() - 7 * 3_600_000, old.reviewId);
  await reconcileMissingChangesRequested();
  assert.equal(iterationsOf(pass.rootId, 2).length, 0);
  assert.equal(iterationsOf(blocked.rootId, 2).length, 0);
  assert.equal(iterationsOf(old.rootId, 2).length, 0);
});
