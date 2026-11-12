import assert from 'node:assert/strict';
import test from 'node:test';
import { foldedStates, foldsHiding, foldView, parseFoldOverrides, toggleFold } from './graph-fold';

const ids = ['main', 'pole', 'lead', 'coder', 'reviewer', 'solo'];
const links = [
  { source: 'main', target: 'pole' },
  { source: 'pole', target: 'lead' },
  { source: 'lead', target: 'coder' },
  { source: 'lead', target: 'reviewer' },
  { source: 'main', target: 'solo' },
];

test('a folded lead hides its roles and counts them', () => {
  const v = foldView(ids, links, (id) => id === 'lead');
  assert.deepEqual([...v.hidden].sort(), ['coder', 'reviewer']);
  assert.equal(v.hiddenBelow.get('lead'), 2);
  assert.deepEqual([...v.parents].sort(), ['lead', 'main', 'pole']);
});

test('a folded ancestor hides a folded descendant and its count', () => {
  const v = foldView(ids, links, (id) => id === 'lead' || id === 'pole');
  assert.deepEqual([...v.hidden].sort(), ['coder', 'lead', 'reviewer']);
  assert.equal(v.hiddenBelow.get('pole'), 3);
  assert.equal(v.hiddenBelow.has('lead'), false);
});

test('a leaf never folds, and a cycle does not loop', () => {
  assert.equal(foldView(ids, links, () => false).hidden.size, 0);
  assert.equal(foldView(ids, links, (id) => id === 'solo').hiddenBelow.size, 0);
  const v = foldView(['a', 'b'], [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }], (id) => id === 'a');
  assert.deepEqual([...v.hidden], ['b']);
});

test('overrides survive a corrupted entry and fall back to the default', () => {
  assert.equal(parseFoldOverrides('{not json').size, 0);
  assert.equal(parseFoldOverrides('[true]').size, 0);
  assert.deepEqual([...parseFoldOverrides('{"lead":false,"x":3}')], [['lead', false]]);
  const opened = toggleFold(new Map(), 'lead', true, true);
  assert.deepEqual([...opened], [['lead', false]]);
  assert.equal(toggleFold(opened, 'lead', false, true).size, 0);
});

test('a hidden busy agent lights its folded ancestor, never once unfolded', () => {
  const folded = foldView(ids, links, (id) => id === 'lead');
  assert.deepEqual([...folded.hiddenOwner].sort(), [['coder', 'lead'], ['reviewer', 'lead']]);
  const states = new Map([['coder', 'thinking'], ['reviewer', 'idle']]);
  assert.deepEqual([...foldedStates(states, folded.hiddenOwner)], [['lead', 'thinking']]);
  const open = foldView(ids, links, () => false);
  assert.deepEqual([...foldedStates(states, open.hiddenOwner)].sort(), [['coder', 'thinking'], ['reviewer', 'idle']]);
});

test('the busiest state wins and a hidden idle agent never dims its owner', () => {
  const v = foldView(ids, links, (id) => id === 'lead' || id === 'pole');
  assert.equal(v.hiddenOwner.get('coder'), 'pole');
  assert.equal(v.hiddenOwner.get('lead'), 'pole');
  const busy = new Map([['pole', 'thinking'], ['lead', 'done'], ['coder', 'needs_action']]);
  assert.equal(foldedStates(busy, v.hiddenOwner).get('pole'), 'needs_action');
  const quiet = new Map([['pole', 'thinking'], ['coder', 'idle'], ['reviewer', 'done']]);
  assert.equal(foldedStates(quiet, v.hiddenOwner).get('pole'), 'thinking');
});

test('an agent created under a folded lead becomes visible once its folds open (TIM-0031)', () => {
  const names = Array.from({ length: 9 }, (_, i) => `agent-${i + 1}`);
  const all = ['main', 'lead', ...names];
  const tree = [{ source: 'main', target: 'lead' }, ...names.map((n) => ({ source: 'lead', target: n }))];
  const open = new Set<string>();
  const folded = (id: string) => id === 'lead' && !open.has(id);

  const before = foldView(all, tree, folded);
  assert.ok(before.hidden.has('agent-8') && before.hidden.has('agent-9'));

  const toOpen = foldsHiding(['agent-9'], tree, folded);
  assert.deepEqual(toOpen, ['lead']);
  toOpen.forEach((id) => open.add(id));
  assert.equal(foldView(all, tree, folded).hidden.size, 0);
});

test('foldsHiding opens every folded ancestor, ignores visible agents and survives a cycle', () => {
  const tree = [
    { source: 'main', target: 'pole' },
    { source: 'pole', target: 'lead' },
    { source: 'lead', target: 'new' },
  ];
  assert.deepEqual(foldsHiding(['new'], tree, (id) => id === 'lead' || id === 'pole').sort(), ['lead', 'pole']);
  assert.deepEqual(foldsHiding(['pole'], tree, (id) => id === 'lead'), []);
  const loop = [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }];
  assert.deepEqual(foldsHiding(['b'], loop, () => true), ['a']);
});
