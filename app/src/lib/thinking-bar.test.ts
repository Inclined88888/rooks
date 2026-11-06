/**
 * The thinking bar every selector draws: its kind follows what the model's
 * dialect can send (levels, a budget, a switch), a control picked by hand wins
 * over the detection, and nothing is drawn for a model that does not think.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BackendCatalog, CatalogBackend, CatalogModel } from './backends';
import { budgetStops, thinkingBarFor, thinkingLabel, thinkingValues } from './thinking-bar';

const QWEN_CATALOG: CatalogModel['reasoning'] = {
  source: 'catalog',
  thinks: true,
  catalogEntry: 'alibaba/qwen3.8-max',
  controls: [{ type: 'toggle' }, { type: 'levels', values: ['low', 'medium', 'xhigh'] }, { type: 'budget', min: 0, max: 262144 }],
};

function catalog(backend: Partial<CatalogBackend> & { models: CatalogModel[] }): BackendCatalog {
  return { defaultBackend: 'bai', backends: [{ id: 'bai', label: 'B.AI', defaultModel: null, custom: true, ...backend }] };
}

const anthropicProtocol = { thinkingControls: ['levels', 'budget', 'toggle'] as CatalogBackend['thinkingControls'] };

test('a catalogue answer on the anthropic protocol is a budget bar, named low / medium / high', () => {
  const bar = thinkingBarFor(catalog({ ...anthropicProtocol, models: [{ slug: 'qwen3.8-max', label: 'Qwen', reasoning: QWEN_CATALOG }] }), 'bai', 'qwen3.8-max');
  assert.equal(bar?.type, 'budget');
  assert.deepEqual(thinkingValues(bar), ['2000', '8000', '32000']);
  assert.deepEqual(bar?.stops.map((stop) => stop.label), ['low', 'medium', 'high']);
  assert.equal(thinkingLabel(bar, '8000'), 'medium');
  assert.equal(thinkingLabel(bar, 'xhigh'), null, 'a value from another model has no position');
});

test('a dialect that only sends levels gets the catalogue levels, never a budget', () => {
  const bar = thinkingBarFor(catalog({ models: [{ slug: 'qwen3.8-max', label: 'Qwen', reasoning: QWEN_CATALOG }] }), 'bai', 'qwen3.8-max');
  assert.equal(bar?.type, 'levels');
  assert.deepEqual(thinkingValues(bar), ['low', 'medium', 'xhigh']);
  const toggleOnly = thinkingBarFor(catalog({ models: [{ slug: 'm', label: 'm', reasoning: { source: 'catalog', thinks: true, controls: [{ type: 'toggle' }] } }] }), 'bai', 'm');
  assert.equal(toggleOnly, null);
});

test('a control declared by hand wins over the catalogue order', () => {
  const declared = (control: NonNullable<CatalogModel['reasoning']>['controls'][number]) => thinkingBarFor(catalog({ ...anthropicProtocol, models: [
    { slug: 'qwen3.8-27b', label: 'Qwen', reasoning: { source: 'declared', thinks: true, controls: [control] } },
  ] }), 'bai', 'qwen3.8-27b');
  const toggle = declared({ type: 'toggle' });
  assert.equal(toggle?.type, 'toggle');
  assert.deepEqual(thinkingValues(toggle), ['off', 'on']);
  assert.deepEqual(thinkingValues(declared({ type: 'budget', max: 4000 })), ['2000', '4000']);
});

test('a choice made by hand wins over levels the endpoint listed for the model', () => {
  // Discovery fills `supportedReasoningLevels` on the view even when the user
  // corrected the model by hand: the correction must still decide the bar.
  const corrected = (reasoning: NonNullable<CatalogModel['reasoning']>) => thinkingBarFor(catalog({ ...anthropicProtocol, models: [
    { slug: 'qwen3.8-max', label: 'Qwen', supportedReasoningLevels: ['low', 'medium', 'high'], reasoning },
  ] }), 'bai', 'qwen3.8-max');
  const budget = corrected({ source: 'declared', thinks: true, controls: [{ type: 'budget', max: 16000 }] });
  assert.equal(budget?.type, 'budget');
  assert.deepEqual(thinkingValues(budget), ['2000', '8000', '16000']);
  assert.equal(corrected({ source: 'declared', thinks: true, controls: [{ type: 'toggle' }] })?.type, 'toggle');
  assert.equal(corrected({ source: 'declared', thinks: false, controls: [] }), null, 'declared as not thinking: no bar');
});

test('levels listed on the model come first, as before', () => {
  const bar = thinkingBarFor(catalog({ ...anthropicProtocol, models: [
    { slug: 'claude-sonnet-4.6', label: 'Sonnet', supportedReasoningLevels: ['low', 'high'], reasoning: { source: 'declared', thinks: true, controls: [{ type: 'levels', values: ['low', 'high'] }] } },
  ] }), 'bai', 'claude-sonnet-4.6');
  assert.equal(bar?.type, 'levels');
  assert.deepEqual(thinkingValues(bar), ['low', 'high']);
});

test('levels the endpoint reported show a slider; a model that does not think, or reports nothing to set, shows none', () => {
  const reported = thinkingBarFor(catalog({ models: [{ slug: 'claude-opus-5-5', label: 'Opus', reasoning: { source: 'agent', thinks: true, controls: [{ type: 'levels', values: ['low', 'max'] }] } }] }), 'bai', 'claude-opus-5-5');
  assert.deepEqual(thinkingValues(reported), ['low', 'max']);
  const none = catalog({ ...anthropicProtocol, models: [
    { slug: 'no', label: 'no', reasoning: { source: 'declared', thinks: false, controls: [] } },
    { slug: 'silent', label: 'silent', reasoning: { source: 'agent', thinks: true, controls: [] } },
    { slug: 'unknown', label: 'unknown' },
  ] });
  assert.equal(thinkingBarFor(none, 'bai', 'no'), null);
  assert.equal(thinkingBarFor(none, 'bai', 'silent'), null);
  assert.equal(thinkingBarFor(none, 'bai', 'unknown'), null);
  assert.equal(thinkingBarFor(none, 'other', 'no'), null);
});

test('budget steps are clamped to the model bounds and merged when they collide', () => {
  assert.deepEqual(budgetStops({}).map((stop) => stop.value), ['2000', '8000', '32000']);
  assert.deepEqual(budgetStops({ max: 16000 }).map((stop) => stop.value), ['2000', '8000', '16000']);
  assert.deepEqual(budgetStops({ min: 10000 }).map((stop) => stop.value), ['10000', '32000']);
  assert.deepEqual(budgetStops({ max: 500 }).map((stop) => stop.value), ['1024'], 'never below what the CLI sends');
});
