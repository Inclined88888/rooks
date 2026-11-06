import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupCatalogReasoning, normalizeModelId, reasoningCatalogInfo, useReasoningSnapshotForTests } from './reasoning-catalog.js';
import { resolveModelReasoning } from './reasoning.js';

const here = dirname(fileURLToPath(import.meta.url));

test('model ids normalize across vendor prefixes, case and dotted versions', () => {
  assert.equal(normalizeModelId('claude-opus-5.5'), normalizeModelId('claude-opus-5-5'));
  assert.equal(normalizeModelId('claude-sonnet-4.6'), normalizeModelId('claude-sonnet-4-6'));
  assert.equal(normalizeModelId('qwen3.8-max'), normalizeModelId('Qwen/Qwen3.8-Max'));
  assert.equal(normalizeModelId('accounts/fireworks/models/qwen3p8-max'), 'qwen3p8-max');
  assert.equal(normalizeModelId('  GPT_5.4-Mini '), 'gpt-5-4-mini');
});

test('B.AI ids resolve to the lab entry when the host is not listed', () => {
  const opus = resolveModelReasoning({ slug: 'claude-opus-5.5', catalog: { baseUrl: 'https://api.b.ai/v1' } });
  assert.deepEqual(opus, {
    source: 'catalog', thinks: true, catalogEntry: 'anthropic/claude-opus-5-5',
    controls: [{ type: 'levels', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
  });
  const sonnet = resolveModelReasoning({ slug: 'claude-sonnet-4.6', catalog: { baseUrl: 'https://api.b.ai/v1' } });
  assert.equal(sonnet?.catalogEntry, 'anthropic/claude-sonnet-4-6');
  assert.deepEqual(sonnet?.controls, [
    { type: 'levels', values: ['low', 'medium', 'high', 'max'] },
    { type: 'budget', min: 1024 },
  ]);
  const mini = resolveModelReasoning({ slug: 'gpt-5.4-mini', catalog: {} });
  assert.equal(mini?.catalogEntry, 'openai/gpt-5.4-mini');
  assert.deepEqual(mini?.controls, [{ type: 'levels', values: ['none', 'low', 'medium', 'high', 'xhigh'] }]);
});

test('Qwen resolves to the Alibaba entry, whatever the host calls it', () => {
  const expected = [
    { type: 'toggle' },
    { type: 'levels', values: ['low', 'medium', 'xhigh'] },
    { type: 'budget', min: 0, max: 262144 },
  ];
  for (const slug of ['qwen3.8-max', 'Qwen/Qwen3.8-Max', 'qwen3p8-max']) {
    const found = resolveModelReasoning({ slug, catalog: { baseUrl: 'https://api.b.ai/v1' } });
    assert.equal(found?.catalogEntry, 'alibaba/qwen3.8-max', slug);
    assert.deepEqual(found?.controls, expected, slug);
  }
});

test('a listed host answers before the lab', () => {
  // empiriolabs relays qwen3.8-max with its own controls (graded effort with an
  // off level, and a budget), which differ from Alibaba's.
  const found = lookupCatalogReasoning('qwen3-8-max', 'https://api.empiriolabs.ai/v1');
  assert.equal(found?.entry, 'empiriolabs/qwen3-8-max');
  assert.deepEqual(found?.options?.[0], { type: 'effort', values: ['none', 'low', 'medium', 'high', 'max'] });
});

test('a model that does not reason, and one the catalogue does not know', () => {
  const plain = resolveModelReasoning({ slug: 'grok-4.20-0309-non-reasoning', catalog: {} });
  assert.deepEqual(plain, { source: 'catalog', thinks: false, controls: [], catalogEntry: 'xai/grok-4.20-0309-non-reasoning' });
  assert.equal(resolveModelReasoning({ slug: 'my-own-finetune-7b', catalog: {} }), undefined);
});

test('declared levels win over the agent, the agent over the catalogue', () => {
  assert.deepEqual(
    resolveModelReasoning({ slug: 'claude-opus-5.5', declaredLevels: ['low', 'high'], agentLevels: ['max'], catalog: {} }),
    { source: 'declared', thinks: true, controls: [{ type: 'levels', values: ['low', 'high'] }] },
  );
  assert.deepEqual(
    resolveModelReasoning({ slug: 'claude-opus-5.5', agentLevels: ['max'], catalog: {} }),
    { source: 'agent', thinks: true, controls: [{ type: 'levels', values: ['max'] }] },
  );
  // Without the caller's leave, the catalogue is not consulted.
  assert.equal(resolveModelReasoning({ slug: 'claude-opus-5.5' }), undefined);
});

test('a control declared by hand wins over the agent and the catalogue, declared levels over it', () => {
  const qwen = { slug: 'qwen3.8-max', catalog: {} };
  assert.deepEqual(resolveModelReasoning({ ...qwen, declaredControl: { type: 'budget', min: 0, max: 4096 } }),
    { source: 'declared', thinks: true, controls: [{ type: 'budget', min: 0, max: 4096 }] });
  assert.deepEqual(resolveModelReasoning({ ...qwen, agentLevels: ['low'], declaredControl: { type: 'toggle' } }),
    { source: 'declared', thinks: true, controls: [{ type: 'toggle' }] });
  assert.deepEqual(resolveModelReasoning({ ...qwen, declaredControl: { type: 'none' } }),
    { source: 'declared', thinks: false, controls: [] });
  assert.deepEqual(resolveModelReasoning({ ...qwen, declaredLevels: ['high'], declaredControl: { type: 'toggle' } })?.controls,
    [{ type: 'levels', values: ['high'] }]);
});

test('an agent that reports no level stops the resolution; an empty declaration does not', () => {
  // claude-opus-5.5 is in the catalogue with five levels: the endpoint's "none"
  // must not be overridden by it.
  assert.deepEqual(
    resolveModelReasoning({ slug: 'claude-opus-5.5', agentLevels: [], catalog: {} }),
    { source: 'agent', thinks: true, controls: [] },
  );
  // An emptied declaration is no declaration: the next source answers.
  assert.deepEqual(
    resolveModelReasoning({ slug: 'claude-opus-5.5', declaredLevels: [], agentLevels: ['max'], catalog: {} }),
    { source: 'agent', thinks: true, controls: [{ type: 'levels', values: ['max'] }] },
  );
  assert.deepEqual(
    resolveModelReasoning({ slug: 'claude-opus-5.5', declaredLevels: [], agentLevels: [], catalog: {} }),
    { source: 'agent', thinks: true, controls: [] },
  );
  assert.equal(resolveModelReasoning({ slug: 'claude-opus-5.5', declaredLevels: [], catalog: {} })?.source, 'catalog');
});

test('entries that disagree answer nothing, and a broken snapshot never throws', (t) => {
  t.after(() => useReasoningSnapshotForTests(null));
  const base = { source: 's', generatedAt: '2026-10-05', license: 'MIT' };
  useReasoningSnapshotForTests(JSON.stringify({
    ...base,
    options: [[{ type: 'toggle' }], [{ type: 'effort', values: ['low', 'high'] }]],
    providers: {
      lab: { models: { 'm-1': [0], 'M.1': [1], solo: [1] } },
      relay: { api: 'relay.example', models: { 'r/thing': [-2, 'lab/solo'] } },
    },
  }));
  assert.equal(lookupCatalogReasoning('m-1'), null, 'two lab entries, two answers');
  assert.equal(lookupCatalogReasoning('thing')?.entry, 'lab/solo', 'through the canonical id');
  assert.equal(lookupCatalogReasoning('r/thing', 'https://relay.example/v1')?.entry, 'lab/solo', 'listed host silent, lab answers');

  useReasoningSnapshotForTests('{"not":"a snapshot"}');
  assert.equal(lookupCatalogReasoning('claude-opus-5-5'), null);
  assert.equal(resolveModelReasoning({ slug: 'claude-opus-5-5', catalog: {} }), undefined);
});

test('the embedded snapshot carries the models.dev licence and stays small', () => {
  const info = reasoningCatalogInfo();
  assert.ok(info?.license.includes('Copyright (c) 2025 models.dev'));
  assert.equal(info?.source, 'https://models.dev/api.json');
  const size = statSync(join(here, 'reasoning-catalog.snapshot.ts')).size;
  assert.ok(size < 640 * 1024, `snapshot is ${Math.round(size / 1024)} KiB`);
});
