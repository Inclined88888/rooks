/**
 * Per-group fallback rules of a series plan (`series_group_fallbacks`, TODO
 * #433). A task of a group of volets reads its group's rules (exact scope, then
 * `*`) before the series-wide ones; the pilot never reads a group. A rule set
 * by hand for a group moves that group's pending tasks only, and a series rule
 * leaves a group that has a rule of its own where it is.
 *
 * `npm test -- src/series-group-fallback.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-group-fallback-test-'));
process.env.TIMON_FALLBACK_ENABLED = '1';
process.env.TIMON_FALLBACK_BACKEND = 'codex';
process.env.TIMON_FALLBACK_MODEL = '';
process.env.TIMON_FALLBACK_COOLDOWN_MS = '3600000';

const { dbApi } = await import('./db.js');
const { mountOfficialProviders, stubCliBinaries } = await import('../tests/helpers/official-providers.js');
await stubCliBinaries('grok');
await mountOfficialProviders();
const { fallbackFor, applySeriesFallbackRule, clearBackendCooldown } = await import('./backend-fallback.js');
const { setBackendBinaryAvailabilityForTest } = await import('./backends/binary-check.js');
setBackendBinaryAvailabilityForTest(() => true);

test('a group rule wins over the series rule, exact scope then wildcard, for its tasks only', () => {
  clearBackendCooldown('claude');
  const seriesId = randomUUID();
  dbApi.setSeriesFallback(seriesId, 'code', 'grok', 'grok-4.6');
  dbApi.setSeriesGroupFallback(seriesId, 'hard', 'code', 'claude', 'opus');
  dbApi.setSeriesGroupFallback(seriesId, 'hard', '*', 'claude', 'sonnet');

  // The group's exact rule.
  assert.deepEqual(fallbackFor('codex', { seriesId, scope: 'code', planGroup: 'hard' }), { backend: 'claude', model: 'opus' });
  // The group's wildcard beats the series' exact rule? There is none for review: the group's `*` applies.
  assert.deepEqual(fallbackFor('codex', { seriesId, scope: 'review', planGroup: 'hard' }), { backend: 'claude', model: 'sonnet' });
  // Outside the group, the series rule of before.
  assert.deepEqual(fallbackFor('claude', { seriesId, scope: 'code' }), { backend: 'grok', model: 'grok-4.6' });
  assert.deepEqual(fallbackFor('claude', { seriesId, scope: 'code', planGroup: 'simple' }), { backend: 'grok', model: 'grok-4.6' });
  // A group `*` also beats a series EXACT rule: the whole group level comes first.
  dbApi.setSeriesFallback(seriesId, 'review', 'grok', 'grok-4.6');
  assert.deepEqual(fallbackFor('codex', { seriesId, scope: 'review', planGroup: 'hard' }), { backend: 'claude', model: 'sonnet' });
});

test('a group rule without backend refuses to fall back for that group alone', () => {
  const seriesId = randomUUID();
  dbApi.setSeriesFallback(seriesId, 'code', 'grok', 'grok-4.6');
  dbApi.setSeriesGroupFallback(seriesId, 'hard', 'code', null, null);
  assert.equal(fallbackFor('claude', { seriesId, scope: 'code', planGroup: 'hard' }), null);
  assert.equal(fallbackFor('claude', { seriesId, scope: 'code' })?.backend, 'grok');
});

test('the pilot never reads a group rule', () => {
  const seriesId = randomUUID();
  dbApi.setSeriesGroupFallback(seriesId, 'hard', '*', 'grok', 'grok-4.6');
  dbApi.setSeriesGroupFallback(seriesId, 'hard', 'orchestrator', 'grok', 'grok-4.6');
  // Nothing series-wide: the global setting (codex) applies to the orchestrator.
  assert.equal(fallbackFor('claude', { seriesId, scope: 'orchestrator', planGroup: 'hard' })?.backend, 'codex');
});

/** A series in flight: two code tasks on grok, one in the "hard" group, one outside. */
function series() {
  const seriesId = randomUUID();
  const pilotId = randomUUID();
  const hardId = randomUUID();
  const plainId = randomUUID();
  dbApi.createMission(pilotId, 'p.main', 'pilot');
  dbApi.setMissionLlmOverrides(pilotId, 'grok', 'grok-4.6');
  dbApi.createTask(hardId, 'hard volet', 'p.coder', {
    type: 'code', seriesId, creatorMissionId: pilotId, planGroup: 'hard',
    backendOverride: 'grok', modelOverride: 'grok-4.6',
  });
  dbApi.createTask(plainId, 'plain volet', 'p.coder', {
    type: 'code', seriesId, creatorMissionId: pilotId,
    backendOverride: 'grok', modelOverride: 'grok-4.6',
  });
  return { seriesId, pilotId, hardId, plainId };
}

test('a rule set by hand for a group moves the pending tasks of that group only', async () => {
  clearBackendCooldown('claude');
  const { seriesId, hardId, plainId } = series();
  dbApi.setSeriesGroupFallback(seriesId, 'hard', 'code', 'claude', 'opus');

  const applied = await applySeriesFallbackRule(seriesId, 'code', 'hard');

  assert.deepEqual(applied, { backend: 'claude', model: 'opus' });
  assert.equal(dbApi.getTask(hardId)?.backend_override, 'claude');
  assert.equal(dbApi.getTask(hardId)?.model_override, 'opus');
  // The task outside the group was not named by the rule.
  assert.equal(dbApi.getTask(plainId)?.backend_override, 'grok');
});

test('a series rule leaves a group that has a rule of its own where it is, and moves the rest', async () => {
  clearBackendCooldown('claude');
  const { seriesId, hardId, plainId } = series();
  dbApi.setSeriesGroupFallback(seriesId, 'hard', 'code', null, null);
  dbApi.setSeriesFallback(seriesId, 'code', 'claude', 'opus');

  await applySeriesFallbackRule(seriesId, 'code');

  assert.equal(dbApi.getTask(plainId)?.backend_override, 'claude');
  // "hard" refuses to fall back: the series rule does not govern it.
  assert.equal(dbApi.getTask(hardId)?.backend_override, 'grok');
});

test('a blocked task of the group is requeued with its group rule, the other group stays blocked', async () => {
  clearBackendCooldown('claude');
  const { seriesId, hardId, plainId } = series();
  dbApi.setTaskInterrupted(hardId, 'exhausted', 'no credit left (HTTP 402)');
  dbApi.setTaskInterrupted(plainId, 'exhausted', 'no credit left (HTTP 402)');
  dbApi.setSeriesGroupFallback(seriesId, 'hard', 'code', 'claude', null);

  await applySeriesFallbackRule(seriesId, 'code', 'hard');

  assert.equal(dbApi.getTask(hardId)?.status, 'PENDING');
  assert.equal(dbApi.getTask(hardId)?.backend_override, 'claude');
  // Not governed by the rule: still blocked, still on its backend.
  assert.equal(dbApi.getTask(plainId)?.status, 'BLOCKED');
  assert.equal(dbApi.getTask(plainId)?.backend_override, 'grok');
});
