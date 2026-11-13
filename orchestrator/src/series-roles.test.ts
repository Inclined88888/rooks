/**
 * Series-scoped role choices (`series_roles`): the planner's per-role picks must
 * reach the tasks the verification loop and doc-task create on their own, without
 * ever being written into `roles.json`.
 *
 * `node --test --import tsx src/series-roles.test.ts`
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
import { agentDir } from './paths.js';
await import('../tests/helpers/claude-provider.js');


const PROJECT = 'acme';
writeRoles(PROJECT, {
  review: { agent: 'acme.reviewer', backend: 'claude', model: 'sonnet' },
  merge: { agent: 'acme.merger', backend: 'claude', model: 'sonnet' },
  doc: { agent: 'acme.librarian', backend: 'claude', model: 'sonnet' },
});
// A librarian must exist for doc-task to create anything.
mkdirSync(agentDir('acme.librarian'), { recursive: true });
writeFileSync(join(agentDir('acme.librarian'), 'config.json'), JSON.stringify({ role: 'librarian', project: PROJECT }));
writeFileSync(join(agentDir('acme.librarian'), 'system-prompt.md'), 'librarian');
const rolesBefore = JSON.stringify(readRoles(PROJECT));

function task(type: TaskType, opts: { seriesId?: string; backend?: string; model?: string } = {}) {
  const id = randomUUID();
  dbApi.createTask(id, `${type} witness`, `acme.${type}`, {
    type, project: PROJECT, seriesId: opts.seriesId ?? null,
    backendOverride: opts.backend ?? null, modelOverride: opts.model ?? null,
  });
  return dbApi.getTask(id)!;
}

{
  const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test('a series review resolves on the series pair, an unrelated review on roles.json', () => {
  const seriesId = randomUUID();
  dbApi.setSeriesRole(seriesId, 'review', 'codex', 'gpt-5.6-sol');

  const inSeries = task('review', { seriesId });
  assert.deepEqual(
    { backend: resolveRoleSpec(inSeries).backend, model: resolveRoleSpec(inSeries).model },
    { backend: 'codex', model: 'gpt-5.6-sol' },
  );
  assert.deepEqual(resolveTaskLlm(inSeries), { backend: 'codex', model: 'gpt-5.6-sol' });

  const outside = task('review');
  assert.deepEqual(resolveTaskLlm(outside), { backend: 'claude', model: 'sonnet' });
  // Another type of the same series is not governed by the review choice.
  assert.deepEqual(resolveTaskLlm(task('merge', { seriesId })), { backend: 'claude', model: 'sonnet' });
});

test('an explicit task override beats the series choice', () => {
  const seriesId = randomUUID();
  dbApi.setSeriesRole(seriesId, 'review', 'codex', 'gpt-5.6-sol');
  const t = task('review', { seriesId, backend: 'claude', model: 'opus' });
  assert.deepEqual(resolveTaskLlm(t), { backend: 'claude', model: 'opus' });
  const spec = resolveRoleSpec(t);
  assert.equal(spec.backend, 'claude');
  assert.equal(spec.model, 'opus');
});

test('a model incompatible with the effective backend is cancelled', () => {
  const seriesId = randomUUID();
  // The task pins the backend only: the series model belongs to another backend.
  dbApi.setSeriesRole(seriesId, 'review', 'codex', 'gpt-5.6-sol');
  const t = task('review', { seriesId, backend: 'claude' });
  assert.deepEqual(resolveTaskLlm(t), { backend: 'claude', model: null });
  assert.equal(resolveRoleSpec(t).model, null);
});

test('the batch cache keeps series choices apart', () => {
  const a = randomUUID();
  const b = randomUUID();
  dbApi.setSeriesRole(a, 'review', 'codex', 'gpt-5.6-sol');
  const cache = { cfg: new Map(), roles: new Map(), series: new Map() };
  assert.equal(resolveTaskLlm(task('review', { seriesId: a }), cache).backend, 'codex');
  assert.equal(resolveTaskLlm(task('review', { seriesId: b }), cache).backend, 'claude');
});

test('merge, review iteration and doc tasks created automatically carry the series', async () => {
  const seriesId = randomUUID();
  dbApi.setSeriesRole(seriesId, 'merge', 'codex', 'gpt-5.6-sol');
  dbApi.setSeriesRole(seriesId, 'code', 'codex', 'gpt-5.6-sol');
  const root = task('code', { seriesId });

  const pass = task('review', { seriesId });
  dbApi.setTaskVerificationMeta(pass.id, 1, root.id);
  dbApi.updateTaskStatus(pass.id, 'DONE', { doneComment: 'verdict: pass' });
  await runVerificationChain(dbApi.getTask(pass.id)!);
  const merge = dbApi.listTasks().find((t) => t.type === 'merge' && t.deps.includes(pass.id));
  assert.ok(merge, 'merge task created');
  assert.equal(merge.series_id, seriesId);
  assert.deepEqual(resolveTaskLlm(merge), { backend: 'codex', model: 'gpt-5.6-sol' });

  const changes = task('review', { seriesId });
  dbApi.setTaskVerificationMeta(changes.id, 1, root.id);
  dbApi.updateTaskStatus(changes.id, 'DONE', { doneComment: 'verdict: changes_requested' });
  await runVerificationChain(dbApi.getTask(changes.id)!);
  const iteration = dbApi.listTasks().find((t) => t.type === 'code' && t.deps.includes(changes.id));
  assert.ok(iteration, 'iteration code task created');
  assert.equal(iteration.series_id, seriesId);
  assert.deepEqual(resolveTaskLlm(iteration), { backend: 'codex', model: 'gpt-5.6-sol' });

  // doc-task reads `series_id` the same way whatever the terminal type.
  const chore = task('chore', { seriesId });
  dbApi.updateTaskStatus(chore.id, 'DONE', { doneComment: 'done' });
  await maybeCreateDocTask(dbApi.getTask(chore.id)!);
  const doc = dbApi.listTasks().find((t) => t.type === 'doc' && t.deps.includes(chore.id));
  assert.ok(doc, 'doc task created');
  assert.equal(doc.series_id, seriesId);
});

test('series choices never touch roles.json', () => {
  assert.equal(JSON.stringify(readRoles(PROJECT)), rolesBefore);
});
