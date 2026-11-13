import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_PINNED_TABS, movePinnedTab, orderStripTabs, parsePinnedTabs, setPinnedTab, togglePinnedTab, withPinnedTabs } from './strip-tabs';

const tab = (name: string, state = 'working') => ({ name, state });
const idle = (name: string) => tab(name, 'idle');

test('pinned tabs come first, in pin order; the rest keep their order', () => {
  const out = orderStripTabs([tab('a'), tab('b'), tab('c'), tab('d')], ['c', 'a'], idle);
  assert.deepEqual(out.map((t) => t.name), ['c', 'a', 'b', 'd']);
});

test('a pinned agent that is not active still gets a tab, and the live one is not duplicated', () => {
  const out = orderStripTabs([tab('a'), tab('b')], ['z', 'b'], idle);
  assert.deepEqual(out, [idle('z'), tab('b'), tab('a')]);
});

test('with no pin the order is untouched', () => {
  const tabs = [tab('x'), tab('y')];
  assert.deepEqual(orderStripTabs(tabs, [], idle), tabs);
});

test('toggling pins then unpins, and the cap drops the oldest pin', () => {
  assert.deepEqual(togglePinnedTab(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(togglePinnedTab(['a', 'b'], 'a'), ['b']);
  const full = Array.from({ length: MAX_PINNED_TABS }, (_, i) => `n${i}`);
  const next = togglePinnedTab(full, 'new');
  assert.equal(next.length, MAX_PINNED_TABS);
  assert.equal(next[0], 'n1');
  assert.equal(next.at(-1), 'new');
});

test('a malformed stored value reads as no pin', () => {
  assert.deepEqual(parsePinnedTabs(null), []);
  assert.deepEqual(parsePinnedTabs('x'), []);
  assert.deepEqual(parsePinnedTabs({ pinned: 'a' }), []);
  assert.deepEqual(parsePinnedTabs({ pinned: ['a', 3, '', 'a', 'b'] }), ['a', 'b']);
});

test('the strip scope is its own row, within the daemon scope limit', async () => {
  const { sharedNavScope, sharedStripScope } = await import('./workspace-scope');
  const strip = await sharedStripScope('rom');
  assert.ok(strip.length <= 64);
  assert.notEqual(strip, await sharedNavScope('rom'));
  assert.notEqual(strip, await sharedStripScope('other'));
});

test('the pin button labels exist in both languages', async () => {
  const { t, setLocale } = await import('./i18n');
  await import('./i18n-test-locales');
  for (const locale of ['en', 'fr'] as const) {
    setLocale(locale);
    assert.match(t('strip.pin', { name: 'x.y' }), /x\.y/);
    assert.match(t('strip.unpin', { name: 'x.y' }), /x\.y/);
  }
  setLocale('en');
});

// SUG-0080: the pinned tabs are put in order by a drag, and that order is the
// one stored, so it is the one every device of the account shows.
test('dropping a pinned tab on another takes that place, both ways', () => {
  assert.deepEqual(movePinnedTab(['a', 'b', 'c', 'd'], 'a', 'c'), ['b', 'c', 'a', 'd']);
  assert.deepEqual(movePinnedTab(['a', 'b', 'c', 'd'], 'd', 'b'), ['a', 'd', 'b', 'c']);
  assert.deepEqual(movePinnedTab(['a', 'b'], 'a', 'zz'), ['a', 'b'], 'a drop on an unpinned tab changes nothing');
  assert.deepEqual(movePinnedTab(['a', 'b'], 'zz', 'a'), ['a', 'b']);
});

test('writing the pins keeps the options stored beside them', () => {
  const row = { pinned: ['a'], options: { groupByProject: true } };
  assert.deepEqual(withPinnedTabs(row, ['b', 'a', 'b']), { pinned: ['b', 'a'], options: { groupByProject: true } });
  assert.deepEqual(withPinnedTabs(null, ['x']), { pinned: ['x'] });
  assert.deepEqual(orderStripTabs([tab('a'), tab('b')], parsePinnedTabs(withPinnedTabs(row, ['b', 'a'])), idle).map((t) => t.name), ['b', 'a']);
});

// TODO #647: a pin click replayed over another window's write keeps its meaning.
test('setting a pin is idempotent where a toggle would undo it', () => {
  assert.deepEqual(setPinnedTab(['a'], 'b', true), ['a', 'b']);
  assert.deepEqual(setPinnedTab(['a', 'b'], 'b', true), ['a', 'b'], 'already pinned elsewhere: stays pinned');
  assert.deepEqual(setPinnedTab(['a'], 'b', false), ['a'], 'already unpinned elsewhere: stays unpinned');
  assert.deepEqual(setPinnedTab(['a', 'b'], 'a', false), ['b']);
});
