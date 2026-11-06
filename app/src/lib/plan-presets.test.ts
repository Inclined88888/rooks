/**
 * Series-planner model presets, without a DOM (`plan-presets.ts`): what a
 * preset applies to the roles asked for, which pairs the catalogue no longer
 * offers, and the list edits the store sends to the daemon (same name
 * replaces, rename refuses a taken name, the ceiling holds).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BackendCatalog } from '@/lib/backends';
import {
  PLAN_PRESETS_MAX, PLAN_PRESET_NAME_MAX, presetPairsFor, readPlanPresets, removePlanPreset,
  renamePlanPreset, upsertPlanPreset, type PlanPreset,
} from './plan-presets';

const CATALOG: BackendCatalog = {
  defaultBackend: 'claude',
  backends: [
    { id: 'claude', label: 'Claude', defaultModel: 'opus', models: [{ slug: 'opus', label: 'Opus' }, { slug: 'haiku', label: 'Haiku' }] },
    {
      id: 'claude@krz', label: 'Claude', defaultModel: 'opus', instanceOf: 'claude',
      account: { id: 'krz', name: 'KRZDIGITAL', state: 'cooldown' }, models: [{ slug: 'opus', label: 'Opus' }],
    },
    { id: 'codex', label: 'Codex', defaultModel: 'gpt-5.5', models: [{ slug: 'gpt-5.5', label: 'GPT-5.5' }] },
  ],
};

const PRESET: PlanPreset = {
  id: 'p1',
  name: 'Night',
  updatedAt: 1,
  roles: {
    orchestrator: { backend: 'claude', model: 'opus' },
    code: { backend: 'claude@krz', model: 'opus' },
    review: { backend: 'codex', model: 'gpt-5.4' },
    merge: { backend: 'claude@gone', model: 'opus' },
    doc: { backend: 'claude', model: 'haiku' },
  },
};

test('presetPairsFor applies the listed pairs to the roles asked for, and names the orphans', () => {
  const { pairs, orphans } = presetPairsFor(PRESET, ['code', 'review', 'merge', 'doc'] as const, CATALOG);
  assert.deepEqual(pairs, {
    code: { backend: 'claude@krz', model: 'opus' },
    doc: { backend: 'claude', model: 'haiku' },
  }, 'an account out of quota is still listed: its pair applies');
  assert.deepEqual(orphans, [
    { role: 'review', backend: 'codex', model: 'gpt-5.4', reason: 'model' },
    { role: 'merge', backend: 'claude@gone', model: 'opus', reason: 'account' },
  ]);
});

test('presetPairsFor leaves out roles not asked for and roles the preset does not set', () => {
  const { pairs, orphans } = presetPairsFor({ roles: { code: { backend: 'claude', model: 'opus' } } }, ['orchestrator', 'code', 'mission'], CATALOG);
  assert.deepEqual(pairs, { code: { backend: 'claude', model: 'opus' } });
  assert.deepEqual(orphans, []);
  assert.deepEqual(presetPairsFor(PRESET, [], CATALOG), { pairs: {}, orphans: [] });
});

test('presetPairsFor judges nothing before the catalogue has loaded', () => {
  const { pairs, orphans } = presetPairsFor(PRESET, ['review', 'merge'], { defaultBackend: '', backends: [] });
  assert.deepEqual(orphans, []);
  assert.deepEqual(pairs, { review: PRESET.roles.review, merge: PRESET.roles.merge });
});

test('readPlanPresets keeps well-formed presets and drops the rest', () => {
  assert.deepEqual(readPlanPresets(null), []);
  assert.deepEqual(readPlanPresets({ presets: 'x' }), []);
  assert.deepEqual(readPlanPresets({
    presets: [
      PRESET,
      { id: 'p2', name: 'Empty', roles: {} },
      { id: 'p3', name: 'Unknown role', roles: { planner: { backend: 'claude', model: 'opus' } } },
      { id: 4, name: 'Bad id', roles: { code: { backend: 'claude', model: 'opus' } } },
      { id: 'p5', name: 'No date', roles: { code: { backend: 'claude', model: '' }, doc: { backend: 'claude', model: 'haiku' } } },
      null,
    ],
  }), [PRESET, { id: 'p5', name: 'No date', roles: { doc: { backend: 'claude', model: 'haiku' } }, updatedAt: 0 }]);
});

test('upsertPlanPreset replaces a preset of the same name in place, without case, keeping its id', () => {
  const other: PlanPreset = { id: 'p2', name: 'Day', roles: { code: { backend: 'codex', model: 'gpt-5.5' } }, updatedAt: 1 };
  const next = upsertPlanPreset([PRESET, other], '  night ', { doc: { backend: 'codex', model: 'gpt-5.5' } }, () => 'new', 9);
  assert.deepEqual(next, [
    { id: 'p1', name: 'night', roles: { doc: { backend: 'codex', model: 'gpt-5.5' } }, updatedAt: 9 },
    other,
  ]);
  const added = upsertPlanPreset([PRESET], 'Weekend', { code: { backend: 'claude', model: 'opus' } }, () => 'new', 9);
  assert.deepEqual(added?.map((p) => p.id), ['p1', 'new']);
});

test('upsertPlanPreset refuses an invalid name, no role, and a new preset past the ceiling', () => {
  const roles = { code: { backend: 'claude', model: 'opus' } };
  assert.equal(upsertPlanPreset([], '   ', roles, () => 'x'), null);
  assert.equal(upsertPlanPreset([], 'x'.repeat(PLAN_PRESET_NAME_MAX + 1), roles, () => 'x'), null);
  assert.equal(upsertPlanPreset([], 'Empty', {}, () => 'x'), null);
  assert.ok(upsertPlanPreset([], 'x'.repeat(PLAN_PRESET_NAME_MAX), roles, () => 'x'));
  const full = Array.from({ length: PLAN_PRESETS_MAX }, (_, i): PlanPreset => ({ id: `p${i}`, name: `n${i}`, roles, updatedAt: 0 }));
  assert.equal(upsertPlanPreset(full, 'one more', roles, () => 'x'), null);
  assert.ok(upsertPlanPreset(full, 'N3', roles, () => 'x'), 'replacing at the ceiling is still allowed');
});

test('renamePlanPreset refuses a taken name, an unknown id and an invalid name; remove drops by id', () => {
  const day: PlanPreset = { id: 'p2', name: 'Day', roles: { code: { backend: 'codex', model: 'gpt-5.5' } }, updatedAt: 1 };
  assert.equal(renamePlanPreset([PRESET, day], 'p2', 'NIGHT'), null);
  assert.equal(renamePlanPreset([PRESET, day], 'nope', 'Other'), null);
  assert.equal(renamePlanPreset([PRESET, day], 'p2', ''), null);
  assert.deepEqual(renamePlanPreset([PRESET, day], 'p1', 'NIGHT', 5)?.[0], { ...PRESET, name: 'NIGHT', updatedAt: 5 }, 'its own name in another case is fine');
  assert.deepEqual(removePlanPreset([PRESET, day], 'p1'), [day]);
});
