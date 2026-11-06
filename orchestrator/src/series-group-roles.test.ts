/**
 * Per-group LLM choices of a series plan (`series_group_roles`, TODO #433): a
 * task of a group of volets resolves on its group's choice before the series'
 * one, and the review, merge, doc and iteration tasks the chain creates carry
 * the group of their root. Resolution: task override > group > series > project
 * role. A task without a group keeps exactly the behaviour of before.
 *
 * `npm test -- src/series-group-roles.test.ts`
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dbApi, type TaskType } from './db.js';
import { readRoles, writeRoles } from './projects.js';
import { resolveRoleSpec, resolveTaskLlm } from './dispatcher.js';
import { runVerificationChain } from './verification-loop.js';
import { maybeCreateDocTask } from './doc-task.js';
import { seriesLlmChoice } from './series-service.js';
import { agentDir } from './paths.js';
await import('../tests/helpers/claude-provider.js');

const PROJECT = 'acme';
writeRoles(PROJECT, {
  code: { agent: 'acme.coder', backend: 'claude', model: 'sonnet' },
  review: { agent: 'acme.reviewer', backend: 'claude', model: 'sonnet' },
  merge: { agent: 'acme.merger', backend: 'claude', model: 'sonnet' },
  doc: { agent: 'acme.librarian', backend: 'claude', model: 'sonnet' },
});
mkdirSync(agentDir('acme.librarian'), { recursive: true });
writeFileSync(join(agentDir('acme.librarian'), 'config.json'), JSON.stringify({ role: 'librarian', project: PROJECT }));
writeFileSync(join(agentDir('acme.librarian'), 'system-prompt.md'), 'librarian');
const rolesBefore = JSON.stringify(readRoles(PROJECT));

function task(type: TaskType, opts: { seriesId?: string; planGroup?: string; backend?: string; model?: string } = {}) {
  const id = randomUUID();
  dbApi.createTask(id, `${type} witness`, `acme.${type}`, {
    type, project: PROJECT, seriesId: opts.seriesId ?? null, planGroup: opts.planGroup ?? null,
    backendOverride: opts.backend ?? null, modelOverride: opts.model ?? null,
  });
  return dbApi.getTask(id)!;
}

{
  const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test('the four levels resolve in order: task override > group > series > project role', () => {
  const seriesId = randomUUID();
  // Project role says sonnet; the series says opus; the "hard" group says codex.
  dbApi.setSeriesRole(seriesId, 'code', 'claude', 'opus');
  dbApi.setSeriesGroupRole(seriesId, 'hard', 'code', 'codex', 'gpt-5.6-sol');

  const outside = task('code');
  assert.deepEqual(resolveTaskLlm(outside), { backend: 'claude', model: 'sonnet' });

  const inSeries = task('code', { seriesId });
  assert.deepEqual(resolveTaskLlm(inSeries), { backend: 'claude', model: 'opus' });

  const inGroup = task('code', { seriesId, planGroup: 'hard' });
  assert.deepEqual(resolveTaskLlm(inGroup), { backend: 'codex', model: 'gpt-5.6-sol' });
  assert.deepEqual(
    { backend: resolveRoleSpec(inGroup).backend, model: resolveRoleSpec(inGroup).model },
    { backend: 'codex', model: 'gpt-5.6-sol' },
  );

  const overridden = task('code', { seriesId, planGroup: 'hard', backend: 'claude', model: 'opus' });
  assert.deepEqual(resolveTaskLlm(overridden), { backend: 'claude', model: 'opus' });
  assert.equal(resolveRoleSpec(overridden).backend, 'claude');
});

test('a group without a choice of its own falls back on the series, then the project', () => {
  const seriesId = randomUUID();
  dbApi.setSeriesGroupRole(seriesId, 'hard', 'code', 'codex', 'gpt-5.6-sol');
  dbApi.setSeriesRole(seriesId, 'review', 'claude', 'opus');
  // Another group of the same series: nothing set for it.
  assert.deepEqual(resolveTaskLlm(task('code', { seriesId, planGroup: 'simple' })), { backend: 'claude', model: 'sonnet' });
  // Same group, another type: the series choice applies.
  assert.deepEqual(resolveTaskLlm(task('review', { seriesId, planGroup: 'hard' })), { backend: 'claude', model: 'opus' });
  // A group that names a model only keeps the series' backend, field by field.
  dbApi.setSeriesGroupRole(seriesId, 'hard', 'review', null, 'sonnet');
  assert.deepEqual(seriesLlmChoice(seriesId, 'review', 'hard'), { backend: 'claude', model: 'sonnet' });
  assert.deepEqual(resolveTaskLlm(task('review', { seriesId, planGroup: 'hard' })), { backend: 'claude', model: 'sonnet' });
});

test('the batch cache keeps the groups of one series apart', () => {
  const seriesId = randomUUID();
  dbApi.setSeriesGroupRole(seriesId, 'hard', 'review', 'codex', 'gpt-5.6-sol');
  const cache = { cfg: new Map(), roles: new Map(), series: new Map() };
  assert.equal(resolveTaskLlm(task('review', { seriesId, planGroup: 'hard' }), cache).backend, 'codex');
  assert.equal(resolveTaskLlm(task('review', { seriesId, planGroup: 'simple' }), cache).backend, 'claude');
  assert.equal(resolveTaskLlm(task('review', { seriesId }), cache).backend, 'claude');
});

test('review, merge, iteration and doc tasks created by the chain carry the group of their root', async () => {
  const seriesId = randomUUID();
  dbApi.setSeriesGroupRole(seriesId, 'hard', 'review', 'codex', 'gpt-5.6-sol');
  dbApi.setSeriesGroupRole(seriesId, 'hard', 'merge', 'codex', 'gpt-5.6-sol');
  dbApi.setSeriesGroupRole(seriesId, 'hard', 'code', 'codex', 'gpt-5.6-sol');
  dbApi.setSeriesGroupRole(seriesId, 'hard', 'doc', 'codex', 'gpt-5.6-sol');
  const root = task('code', { seriesId, planGroup: 'hard' });

  // The code → review step needs a worktree with a diff (git): the review is
  // laid down by hand with the group, as the chain would (same `root.plan_group`).
  const review = task('review', { seriesId, planGroup: 'hard' });
  dbApi.setTaskVerificationMeta(review.id, 1, root.id);
  assert.deepEqual(resolveTaskLlm(review), { backend: 'codex', model: 'gpt-5.6-sol' });

  // review pass → merge with the group.
  dbApi.updateTaskStatus(review.id, 'DONE', { doneComment: 'verdict: pass' });
  await runVerificationChain(dbApi.getTask(review.id)!);
  const merge = dbApi.listTasks().find((t) => t.type === 'merge' && t.deps.includes(review.id));
  assert.ok(merge, 'merge task created');
  assert.equal(merge.plan_group, 'hard');
  assert.deepEqual(resolveTaskLlm(merge), { backend: 'codex', model: 'gpt-5.6-sol' });

  // review changes_requested → code iteration with the group.
  const changes = task('review', { seriesId, planGroup: 'hard' });
  dbApi.setTaskVerificationMeta(changes.id, 1, root.id);
  dbApi.updateTaskStatus(changes.id, 'DONE', { doneComment: 'verdict: changes_requested' });
  await runVerificationChain(dbApi.getTask(changes.id)!);
  const iteration = dbApi.listTasks().find((t) => t.type === 'code' && t.deps.includes(changes.id));
  assert.ok(iteration, 'iteration code task created');
  assert.equal(iteration.plan_group, 'hard');

  // terminal task → doc with the group.
  const chore = task('chore', { seriesId, planGroup: 'hard' });
  dbApi.updateTaskStatus(chore.id, 'DONE', { doneComment: 'done' });
  await maybeCreateDocTask(dbApi.getTask(chore.id)!);
  const doc = dbApi.listTasks().find((t) => t.type === 'doc' && t.deps.includes(chore.id));
  assert.ok(doc, 'doc task created');
  assert.equal(doc.plan_group, 'hard');
  assert.deepEqual(resolveTaskLlm(doc), { backend: 'codex', model: 'gpt-5.6-sol' });
});

test('a root without a group leaves its chain without one', async () => {
  const seriesId = randomUUID();
  const root = task('code', { seriesId });
  const review = task('review', { seriesId });
  dbApi.setTaskVerificationMeta(review.id, 1, root.id);
  dbApi.updateTaskStatus(review.id, 'DONE', { doneComment: 'verdict: pass' });
  await runVerificationChain(dbApi.getTask(review.id)!);
  const merge = dbApi.listTasks().find((t) => t.type === 'merge' && t.deps.includes(review.id));
  assert.ok(merge, 'merge task created');
  assert.equal(merge.plan_group, null);
});

test('group choices never touch roles.json, and clearing one restores the series choice', () => {
  const seriesId = randomUUID();
  dbApi.setSeriesRole(seriesId, 'code', 'claude', 'opus');
  dbApi.setSeriesGroupRole(seriesId, 'hard', 'code', 'codex', 'gpt-5.6-sol');
  assert.deepEqual(dbApi.listSeriesGroupRoles(seriesId).map((r) => [r.plan_group, r.scope, r.backend]), [['hard', 'code', 'codex']]);
  dbApi.clearSeriesGroupRole(seriesId, 'hard', 'code');
  assert.deepEqual(resolveTaskLlm(task('code', { seriesId, planGroup: 'hard' })), { backend: 'claude', model: 'opus' });
  assert.equal(JSON.stringify(readRoles(PROJECT)), rolesBefore);
});
