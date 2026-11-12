import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelIdsFromList, modelIdsFromSessionNew, normalizeDiscoveredModels } from './model-ids.js';

test('modelIdsFromSessionNew reads both shapes ACP agents use, once per id', () => {
  assert.deepEqual(modelIdsFromSessionNew({ models: { availableModels: [{ modelId: 'a' }, { modelId: 'b' }, { modelId: 'a' }, {}] } }), ['a', 'b']);
  assert.deepEqual(modelIdsFromSessionNew({
    configOptions: [{ category: 'model', options: [{ value: 'x' }, { group: 'g', options: [{ value: 'y' }] }] }],
  }), ['x', 'y']);
  for (const junk of [null, 3, 'x', [], {}, { models: 4 }]) assert.deepEqual(modelIdsFromSessionNew(junk), []);
});

test('normalizeDiscoveredModels accepts ids and objects, and drops the unusable', () => {
  assert.deepEqual(
    normalizeDiscoveredModels(['a', { slug: 'b', supportedReasoningLevels: ['low'] }, '', { slug: '' }]),
    [{ slug: 'a' }, { slug: 'b', supportedReasoningLevels: ['low'] }],
  );
});

test('modelIdsFromList reads an OpenAI-style listing and refuses anything else', () => {
  assert.deepEqual(modelIdsFromList({ data: [{ id: 'm1' }, { id: 'm2' }, { object: 'x' }] }), ['m1', 'm2']);
  assert.throws(() => modelIdsFromList({ data: [] }), /no model/);
  assert.throws(() => modelIdsFromList({}), /data/);
  assert.throws(() => modelIdsFromList(null), /data/);
});
