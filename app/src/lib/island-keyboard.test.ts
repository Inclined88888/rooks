import assert from 'node:assert/strict';
import test from 'node:test';
import { collectLeaves, defaultIslandTree, insertAt, layoutRects, type IslandContent, type IslandTree } from './island-tree';
import {
  arrowDirection,
  cycleIsland,
  initialMoveTarget,
  islandInDirection,
  isIslandFocusKey,
  moveKeyOf,
  nextRegion,
  tabForKey,
} from './island-keyboard';

const term = (sessionId: string): IslandContent => ({ type: '@timon/terminal-web:session', params: { sessionId } });
const BOX = { x: 0, y: 0, width: 1200, height: 800 };

/** route | (a over b): three islands, the right column stacked. */
function threeIslands(): { tree: IslandTree; route: string; a: string; b: string } {
  let tree = defaultIslandTree();
  const route = tree.root.id;
  tree = insertAt(tree, route, 'right', term('a')).tree;
  const a = collectLeaves(tree.root).find((leaf) => leaf.id !== route)!.id;
  tree = insertAt(tree, a, 'bottom', term('b')).tree;
  const b = collectLeaves(tree.root).find((leaf) => leaf.id !== route && leaf.id !== a)!.id;
  return { tree, route, a, b };
}

test('arrows pick the island on that side, the one straight ahead first', () => {
  const { tree, route, a, b } = threeIslands();
  const layout = layoutRects(tree, BOX, 8);
  assert.equal(islandInDirection(layout, route, 'right'), a, 'a tie goes to the first in reading order');
  assert.equal(islandInDirection(layout, a, 'down'), b);
  assert.equal(islandInDirection(layout, b, 'up'), a);
  assert.equal(islandInDirection(layout, b, 'left'), route);
  assert.equal(islandInDirection(layout, route, 'left'), null, 'nothing that way');
  assert.equal(islandInDirection(layout, a, 'up'), null);
  assert.equal(islandInDirection(layout, 'nope', 'up'), null);
});

test('Tab walks the places of an island, both ways, wrapping', () => {
  assert.equal(nextRegion('center'), 'right');
  assert.equal(nextRegion('top'), 'center');
  assert.equal(nextRegion('center', true), 'top');
  assert.equal(arrowDirection('ArrowUp'), 'up');
  assert.equal(arrowDirection('Enter'), null);
});

test('the mode starts on another island, or beside its own tab', () => {
  const { tree, route, a } = threeIslands();
  const layout = layoutRects(tree, BOX, 8);
  assert.deepEqual(initialMoveTarget(tree, layout, { kind: 'island', islandId: route }), { islandId: a, region: 'center' });
  const tabs = defaultIslandTree();
  const two = { ...tabs, root: { ...tabs.root, tabs: [...(tabs.root.kind === 'leaf' ? tabs.root.tabs : []), { id: 't2', content: term('x') }] } } as IslandTree;
  const alone = layoutRects(two, BOX, 8);
  assert.deepEqual(initialMoveTarget(two, alone, { kind: 'tab', tabId: 't2' }), { islandId: two.root.id, region: 'right' });
  assert.equal(initialMoveTarget(two, alone, { kind: 'tab', tabId: 'gone' }), null);
});

test('the focus key cycles the islands in reading order', () => {
  const { tree, route, a, b } = threeIslands();
  assert.equal(cycleIsland(tree, route), a);
  assert.equal(cycleIsland(tree, b), route, 'wraps');
  assert.equal(cycleIsland(tree, route, true), b);
  assert.equal(cycleIsland(tree, null), route);
  assert.ok(isIslandFocusKey({ key: 'F6', altKey: false, ctrlKey: false, metaKey: false }));
  assert.ok(!isIslandFocusKey({ key: 'F6', altKey: false, ctrlKey: true, metaKey: false }), 'Ctrl+F6 is left alone');
});

test('the tab bar keys follow the ARIA tabs pattern', () => {
  const tabs = ['x', 'y', 'z'];
  assert.equal(tabForKey(tabs, 'x', 'ArrowRight'), 'y');
  assert.equal(tabForKey(tabs, 'z', 'ArrowRight'), 'x');
  assert.equal(tabForKey(tabs, 'x', 'ArrowLeft'), 'z');
  assert.equal(tabForKey(tabs, 'y', 'Home'), 'x');
  assert.equal(tabForKey(tabs, 'y', 'End'), 'z');
  assert.equal(tabForKey(tabs, 'y', 'a'), null);
  assert.equal(tabForKey([], 'y', 'End'), null);
});

test('M moves the focused tab, Shift+M its island, nothing with a modifier', () => {
  const k = (key: string, mods: Partial<Record<'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey', boolean>> = {}) =>
    moveKeyOf({ key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods });
  assert.equal(k('m'), 'tab');
  assert.equal(k('M', { shiftKey: true }), 'island');
  assert.equal(k('m', { ctrlKey: true }), null);
  assert.equal(k('m', { metaKey: true }), null);
  assert.equal(k('m', { altKey: true }), null);
  assert.equal(k('n'), null);
});
