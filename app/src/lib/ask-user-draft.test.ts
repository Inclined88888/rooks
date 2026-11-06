/**
 * SUG-0014: a form that expired came back as a new card with nothing ticked.
 * The same questions in the same mission now start from the old card's draft.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askDraftKey, clearAskDraft, loadAskDraft, saveAskDraft } from './ask-user-draft';
import type { AskUserQuestion } from './ask-user-answers';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

const questions: AskUserQuestion[] = [
  { question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] },
  { question: 'Which checks?', multiSelect: true, options: [{ label: 'lint' }, { label: 'types' }] },
  { question: 'Anything else?' },
];

test('the same questions in the same mission get the draft back', () => {
  const storage = memoryStorage();
  saveAskDraft(storage, 'm1', questions, {
    picks: { 'Which branch?': 'dev', 'Which checks?': ['lint'], 'Anything else?': '' },
    custom: { 'Anything else?': 'ship it tonight' },
  });
  assert.deepEqual(loadAskDraft(storage, 'm1', questions), {
    picks: { 'Which branch?': 'dev', 'Which checks?': ['lint'], 'Anything else?': '' },
    custom: { 'Anything else?': 'ship it tonight' },
  });
});

test('another mission or other questions start empty', () => {
  const storage = memoryStorage();
  saveAskDraft(storage, 'm1', questions, { picks: { 'Which branch?': 'dev' }, custom: {} });
  assert.equal(loadAskDraft(storage, 'm2', questions), null);
  assert.equal(loadAskDraft(storage, 'm1', questions.slice(0, 2)), null);
  assert.equal(loadAskDraft(storage, null, questions), null);
  assert.equal(loadAskDraft(null, 'm1', questions), null);
});

test('an option the new card no longer offers is dropped from the draft', () => {
  const storage = memoryStorage();
  const renamed: AskUserQuestion[] = [
    { question: 'Which branch?', options: [{ label: 'main' }, { label: 'release' }] },
    { question: 'Which checks?', multiSelect: true, options: [{ label: 'types' }] },
    { question: 'Anything else?' },
  ];
  storage.setItem(askDraftKey('m1', renamed), JSON.stringify({
    picks: { 'Which branch?': 'dev', 'Which checks?': ['lint', 'types'] },
    custom: { 'Which branch?': 'or a hotfix branch' },
  }));
  assert.deepEqual(loadAskDraft(storage, 'm1', renamed), {
    picks: { 'Which branch?': '', 'Which checks?': ['types'], 'Anything else?': '' },
    custom: { 'Which branch?': 'or a hotfix branch' },
  });
});

test('an empty draft is not kept, a sent one is cleared, a corrupt one is ignored', () => {
  const storage = memoryStorage();
  saveAskDraft(storage, 'm1', questions, { picks: { 'Which branch?': 'main' }, custom: {} });
  assert.equal(storage.map.size, 1);
  saveAskDraft(storage, 'm1', questions, { picks: { 'Which branch?': '' }, custom: { 'Anything else?': '  ' } });
  assert.equal(storage.map.size, 0);

  saveAskDraft(storage, 'm1', questions, { picks: { 'Which branch?': 'main' }, custom: {} });
  clearAskDraft(storage, 'm1', questions);
  assert.equal(storage.map.size, 0);

  storage.setItem(askDraftKey('m1', questions), '{not json');
  assert.equal(loadAskDraft(storage, 'm1', questions), null);
});
