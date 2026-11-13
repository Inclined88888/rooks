import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, renderModule, MODELS_DEV_LICENSE } from './gen-reasoning-catalog.mjs';

const api = {
  zeta: {
    name: 'Zeta relay', api: 'https://API.Zeta.example/v1', cost: { input: 1 },
    models: {
      'lab/m-1': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }], canonical_model_id: 'lab/m-1', cost: { input: 1 } },
      silent: { reasoning: true },
      relayed: { reasoning: true, canonical_model_id: 'lab/m-1' },
    },
  },
  lab: {
    name: 'Lab',
    models: {
      'm-1': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }], description: 'dropped' },
      'm-2': { reasoning: false },
      'm-3': { reasoning: true, reasoning_options: [{ type: 'budget_tokens', min: 1024, max: 8000, extra: 1 }, { type: 'toggle' }, { type: 'mystery' }] },
      'm-4': { reasoning: true, reasoning_options: [] },
    },
  },
};

test('keeps only ids, canonical ids and reasoning, with shared option sets', () => {
  const snapshot = buildSnapshot(api, '2026-10-05');
  assert.equal(snapshot.license, MODELS_DEV_LICENSE);
  assert.deepEqual(Object.keys(snapshot.providers), ['lab', 'zeta'], 'providers sorted');
  assert.equal(snapshot.providers.zeta.api, 'api.zeta.example');
  assert.equal(snapshot.providers.lab.api, undefined);
  const effort = snapshot.providers.lab.models['m-1'][0];
  assert.deepEqual(snapshot.options[effort], [{ type: 'effort', values: ['low', 'high'] }]);
  assert.deepEqual(snapshot.providers.zeta.models['lab/m-1'], [effort, 'lab/m-1'], 'same set, same index');
  assert.deepEqual(snapshot.providers.lab.models['m-2'], [-1]);
  assert.deepEqual(snapshot.options[snapshot.providers.lab.models['m-3'][0]], [{ type: 'budget_tokens', min: 1024, max: 8000 }, { type: 'toggle' }]);
  assert.deepEqual(snapshot.options[snapshot.providers.lab.models['m-4'][0]], []);
  assert.deepEqual(snapshot.providers.zeta.models.relayed, [-2, 'lab/m-1'], 'unknown options, canonical kept');
  assert.equal(snapshot.providers.zeta.models.silent, undefined, 'nothing to say, dropped');
  assert.ok(!JSON.stringify(snapshot).includes('dropped'));
});

test('the output does not depend on the provider order of the source', () => {
  const reversed = Object.fromEntries(Object.entries(api).reverse());
  assert.equal(JSON.stringify(buildSnapshot(reversed, 'd')), JSON.stringify(buildSnapshot(api, 'd')));
});

test('the module carries the licence and a parseable string', async () => {
  const body = renderModule(buildSnapshot(api, '2026-10-05'));
  assert.ok(body.includes(' * Copyright (c) 2025 models.dev'));
  const literal = /export const REASONING_SNAPSHOT_JSON = (".*");\n$/.exec(body)?.[1];
  assert.ok(literal);
  assert.equal(JSON.parse(JSON.parse(literal)).generatedAt, '2026-10-05');
});
