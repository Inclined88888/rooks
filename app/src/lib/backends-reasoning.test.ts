/**
 * The thinking levels of a model, as every selector reads them (agent editor,
 * chat composer, LLM menu and dialog, workflow node). A versioned slug the
 * catalog does not list (`claude-opus-5-5`, pinned by hand to force a version)
 * still belongs to the backend that claims its prefix: it keeps the levels of
 * its family instead of silently losing the slider.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reasoningLevelsFor, type BackendCatalog } from './backends';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const catalog: BackendCatalog = {
  defaultBackend: 'claude',
  backends: [
    {
      id: 'claude',
      label: 'Claude',
      defaultModel: 'sonnet',
      slugPrefixes: ['claude-'],
      models: [
        { slug: 'sonnet', label: 'sonnet', supportedReasoningLevels: EFFORTS },
        { slug: 'opus', label: 'opus', supportedReasoningLevels: EFFORTS },
      ],
    },
    {
      id: 'codex',
      label: 'Codex',
      defaultModel: 'gpt-5.5',
      models: [
        { slug: 'gpt-5.5', label: 'gpt-5.5', supportedReasoningLevels: ['low', 'high'] },
        { slug: 'no-levels', label: 'no-levels' },
      ],
    },
    { id: 'custom', label: 'Custom', defaultModel: null, models: [] },
  ],
};

test('a cataloged slug keeps its own levels', () => {
  assert.deepEqual(reasoningLevelsFor(catalog, 'claude', 'opus'), EFFORTS);
  assert.deepEqual(reasoningLevelsFor(catalog, 'codex', 'gpt-5.5'), ['low', 'high']);
});

test('a versioned slug forced over an alias keeps the slider (TODO #174)', () => {
  assert.deepEqual(reasoningLevelsFor(catalog, 'claude', 'claude-opus-5-5'), EFFORTS);
  assert.deepEqual(reasoningLevelsFor(catalog, 'claude', 'claude-sonnet-5-5'), EFFORTS);
});

test('a versioned slug locally added to the catalog without levels inherits its family', () => {
  const added: BackendCatalog = {
    ...catalog,
    backends: [
      { ...catalog.backends[0]!, models: [...catalog.backends[0]!.models, { slug: 'claude-opus-5-5', label: 'claude-opus-5-5' }] },
      ...catalog.backends.slice(1),
    ],
  };
  assert.deepEqual(reasoningLevelsFor(added, 'claude', 'claude-opus-5-5'), EFFORTS);
});

test('a versioned slug with no family match gets only the levels the whole backend shares', () => {
  assert.deepEqual(reasoningLevelsFor(catalog, 'claude', 'claude-mystery-9'), EFFORTS);
  const mixed: BackendCatalog = {
    ...catalog,
    backends: [
      {
        ...catalog.backends[0]!,
        models: [
          { slug: 'sonnet', label: 'sonnet', supportedReasoningLevels: ['low', 'high'] },
          { slug: 'opus', label: 'opus', supportedReasoningLevels: ['high', 'max'] },
        ],
      },
    ],
  };
  assert.deepEqual(reasoningLevelsFor(mixed, 'claude', 'claude-mystery-9'), ['high']);
});

test('a slug no backend claims, or a model that declares nothing, gets no slider', () => {
  assert.deepEqual(reasoningLevelsFor(catalog, 'claude', 'gpt-5.5'), []);
  assert.deepEqual(reasoningLevelsFor(catalog, 'codex', 'claude-opus-5-5'), []);
  assert.deepEqual(reasoningLevelsFor(catalog, 'codex', 'no-levels'), []);
  assert.deepEqual(reasoningLevelsFor(catalog, 'custom', 'whatever'), []);
  assert.deepEqual(reasoningLevelsFor(catalog, 'unknown', 'opus'), []);
});

test('an empty model has no levels', () => {
  assert.deepEqual(reasoningLevelsFor(catalog, 'claude', ''), []);
});
