import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewModel } from './backends';
import { byPower } from './llm-sort';

test('new badges expire after seven days and reject future timestamps', () => {
  const addedAt = 1000;
  assert.equal(isNewModel({}, addedAt), false);
  assert.equal(isNewModel({ addedAt }, addedAt - 1), false);
  assert.equal(isNewModel({ addedAt }, addedAt), true);
  assert.equal(isNewModel({ addedAt }, addedAt + 7 * 86400000), false);
});

test('fresh exact models precede presets without replacing their slugs', () => {
  const sorted = byPower([
    { slug: 'fable', label: 'Alias', presetRank: 0 },
    { slug: 'claude-fable-5-1', label: 'Pinned', addedAt: Date.now() },
  ]);
  assert.equal(sorted[0]?.slug, 'claude-fable-5-1');
});
