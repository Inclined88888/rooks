/**
 * TODO #515: the series planner (`kanban_plan`) lost everything on a reload
 * or when its card expired and came back. Its draft now lives in the session,
 * keyed by mission + job + workstreams, and is reduced to what the new card
 * still offers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearSeriesPlanDraft, loadSeriesPlanDraft, saveSeriesPlanDraft, seriesPlanDraftKey, type SeriesPlanDraft,
} from './series-plan-draft';
import type { SeriesPlanFormPayload } from '../components/series-plan-form';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

const form: SeriesPlanFormPayload = {
  kind: 'series_plan',
  chantier: 'Big job',
  volets: [{ title: 'A', group: 'simple' }, { title: 'B', group: 'complex' }, { title: 'C' }],
};

const draft: SeriesPlanDraft = {
  mode: 'kanban-code-group',
  picks: { 'code:main': { backend: 'claude', model: 'opus' }, 'orchestrator:fallback': { backend: 'codex', model: 'gpt-5.5' } },
  groupPicks: { complex: { 'code:main': { backend: 'claude', model: 'opus' } } },
  groupCustom: { simple: true },
  note: 'merge volet B first',
};

test('the same plan in the same mission gets its draft back', () => {
  const storage = memoryStorage();
  saveSeriesPlanDraft(storage, 'm1', form, draft);
  assert.deepEqual(loadSeriesPlanDraft(storage, 'm1', form), draft);
  // The defaults the daemon resolves are not part of the key: they can move between two cards.
  assert.deepEqual(loadSeriesPlanDraft(storage, 'm1', { ...form, defaults: { code: { model: 'claude / sonnet' } } }), draft);
});

test('another mission, another job or other workstreams start empty', () => {
  const storage = memoryStorage();
  saveSeriesPlanDraft(storage, 'm1', form, draft);
  assert.equal(loadSeriesPlanDraft(storage, 'm2', form), null);
  assert.equal(loadSeriesPlanDraft(storage, 'm1', { ...form, chantier: 'Other job' }), null);
  assert.equal(loadSeriesPlanDraft(storage, 'm1', { ...form, volets: form.volets.slice(1) }), null);
  assert.equal(loadSeriesPlanDraft(storage, 'm1', { ...form, volets: [{ title: 'A', group: 'complex' }, ...form.volets.slice(1)] }), null);
});

test('no mission, no storage: nothing kept, nothing read, nothing thrown', () => {
  const storage = memoryStorage();
  saveSeriesPlanDraft(storage, null, form, draft);
  assert.equal(storage.map.size, 0);
  assert.equal(loadSeriesPlanDraft(null, 'm1', form), null);
  saveSeriesPlanDraft(null, 'm1', form, draft);
  clearSeriesPlanDraft(null, 'm1', form);
});

test('an untouched form stores nothing and takes back an earlier draft', () => {
  const storage = memoryStorage();
  saveSeriesPlanDraft(storage, 'm1', form, draft);
  saveSeriesPlanDraft(storage, 'm1', form, { mode: 'kanban-full', picks: {}, groupPicks: {}, groupCustom: {}, note: '  ' });
  assert.equal(storage.map.size, 0);
});

test('clear drops the draft', () => {
  const storage = memoryStorage();
  saveSeriesPlanDraft(storage, 'm1', form, draft);
  clearSeriesPlanDraft(storage, 'm1', form);
  assert.equal(loadSeriesPlanDraft(storage, 'm1', form), null);
});

test('a stored draft is reduced to what the card offers: unknown mode, role, column, group or malformed pair are dropped', () => {
  const storage = memoryStorage();
  storage.setItem(seriesPlanDraftKey('m1', form), JSON.stringify({
    mode: 'yolo',
    picks: {
      'code:main': { backend: 'claude', model: 'opus' },
      'boss:main': { backend: 'claude', model: 'opus' },
      'constructor:main': { backend: 'claude', model: 'opus' },
      'code:third': { backend: 'claude', model: 'opus' },
      'code:main:x': { backend: 'claude', model: 'opus' },
      'doc:main': { backend: 'claude' },
      'doc:fallback': { backend: '', model: 'opus' },
      'review:main': 'claude / opus',
    },
    groupPicks: {
      complex: { 'orchestrator:main': { backend: 'claude', model: 'opus' }, 'merge:fallback': { backend: 'codex', model: 'gpt-5.5', extra: 1 } },
      gone: { 'code:main': { backend: 'claude', model: 'opus' } },
    },
    groupCustom: { simple: 'yes', complex: true, gone: true, toString: true },
    note: 42,
  }));
  assert.deepEqual(loadSeriesPlanDraft(storage, 'm1', form), {
    mode: 'kanban-full',
    picks: { 'code:main': { backend: 'claude', model: 'opus' } },
    groupPicks: { complex: { 'merge:fallback': { backend: 'codex', model: 'gpt-5.5' } } },
    groupCustom: { complex: true },
    note: '',
  });
});

test('garbage in the storage is no draft', () => {
  const storage = memoryStorage();
  storage.setItem(seriesPlanDraftKey('m1', form), '{not json');
  assert.equal(loadSeriesPlanDraft(storage, 'm1', form), null);
  storage.setItem(seriesPlanDraftKey('m1', form), JSON.stringify({ mode: 'kanban-full', note: '' }));
  assert.equal(loadSeriesPlanDraft(storage, 'm1', form), null);
});

test('a full or blocked storage costs the draft, never the form', () => {
  const throwing = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('quota'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  assert.doesNotThrow(() => saveSeriesPlanDraft(throwing, 'm1', form, draft));
  assert.doesNotThrow(() => clearSeriesPlanDraft(throwing, 'm1', form));
  assert.equal(loadSeriesPlanDraft(throwing, 'm1', form), null);
});
