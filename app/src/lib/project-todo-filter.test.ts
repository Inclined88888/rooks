import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countByUrgency, filterByUrgency, toggleUrgency, URGENCY_FILTER_KEYS, urgencyKey, visibleUrgencyKeys,
  type UrgencyFilterKey,
} from './project-todo-filter';
import { TODO_URGENCIES } from './project-todo-tags';

const items = [
  { id: 1, urgency: 'bug' as const },
  { id: 2, urgency: 'idea' as const },
  { id: 3, urgency: null },
  { id: 4, urgency: 'bug' as const },
  { id: 5 },
];

test('every urgency has a filter key, plus one for untagged ideas', () => {
  assert.deepEqual(URGENCY_FILTER_KEYS, [...TODO_URGENCIES, 'none']);
  assert.equal(urgencyKey({ urgency: null }), 'none');
  assert.equal(urgencyKey({}), 'none');
  assert.equal(urgencyKey({ urgency: 'critical' }), 'critical');
});

test('counts cover every key, untagged ones included', () => {
  assert.deepEqual(countByUrgency(items), { critical: 0, bug: 2, minor: 0, idea: 1, none: 2 });
  assert.deepEqual(countByUrgency([]), { critical: 0, bug: 0, minor: 0, idea: 0, none: 0 });
});

test('no selected key shows everything', () => {
  assert.deepEqual(filterByUrgency(items, new Set()).map((i) => i.id), [1, 2, 3, 4, 5]);
});

test('selected keys add up, order is kept', () => {
  assert.deepEqual(filterByUrgency(items, new Set<UrgencyFilterKey>(['bug'])).map((i) => i.id), [1, 4]);
  assert.deepEqual(filterByUrgency(items, new Set<UrgencyFilterKey>(['none', 'idea'])).map((i) => i.id), [2, 3, 5]);
  assert.deepEqual(filterByUrgency(items, new Set<UrgencyFilterKey>(['critical'])), []);
});

test('toggling switches a key on then off without touching the given set', () => {
  const empty = new Set<UrgencyFilterKey>();
  const on = toggleUrgency(empty, 'bug');
  assert.deepEqual([...on], ['bug']);
  assert.equal(empty.size, 0);
  assert.deepEqual([...toggleUrgency(on, 'bug')], []);
});

test('chips at 0 are hidden unless selected', () => {
  const counts = countByUrgency(items);
  assert.deepEqual(visibleUrgencyKeys(counts, new Set()), ['bug', 'idea', 'none']);
  assert.deepEqual(visibleUrgencyKeys(counts, new Set<UrgencyFilterKey>(['critical'])), ['critical', 'bug', 'idea', 'none']);
});
