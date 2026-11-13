import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HOST_ROUTE,
  MAX_FLOATS,
  collectLeaves,
  defaultIslandTree,
  floatLeaf,
  floatOf,
  insertAtRoot,
  isDefaultIslandTree,
  openFloat,
  setFloatMinimized,
  setFloatPinned,
  type IslandTree,
} from './island-tree';
import { emptyAmbient, mergeAmbient, readAmbient, splitAmbient } from './island-ambient';

const box = { x: 0.3, y: 0.2, width: 0.4, height: 0.5 };
const term = (sessionId: string) => ({ type: '@rooks/terminal-web:session', params: { sessionId } });

function viewWithPopup(session = 'a'): { tree: IslandTree; leafId: string } {
  const opened = insertAtRoot(defaultIslandTree(), 'right', term(session));
  assert.equal(opened.refused, null);
  const leaf = collectLeaves(opened.tree.root).find((l) => l.tabs[0]?.content.type !== HOST_ROUTE)!;
  const floated = floatLeaf(opened.tree, leaf.id, box);
  assert.equal(floated.refused, null);
  return { tree: floated.tree, leafId: leaf.id };
}

test('a tree with a popup is not the default one: it is painted and stored', () => {
  assert.equal(isDefaultIslandTree(viewWithPopup().tree), false);
});

test('openFloat opens a content straight into a popup, and moves an open one out', () => {
  const popup = openFloat(defaultIslandTree(), term('a'), box);
  assert.equal(popup.refused, null);
  assert.equal(popup.tree.floats?.length, 1);
  const open = insertAtRoot(defaultIslandTree(), 'right', term('b'));
  const moved = openFloat(open.tree, term('b'), box, { existing: (c) => c.params.sessionId === 'b' });
  assert.equal(moved.refused, null);
  assert.equal(moved.tree.floats?.length, 1);
  assert.equal(collectLeaves(moved.tree.root).length, 1);
});

test('pinning flags the popup, unpinning clears it, and neither duplicates anything', () => {
  const { tree, leafId } = viewWithPopup();
  const pinned = setFloatPinned(tree, leafId, true);
  assert.equal(pinned.refused, null);
  assert.equal(floatOf(pinned.tree, leafId)?.pinned, true);
  const again = setFloatPinned(pinned.tree, leafId, true);
  assert.equal(again.tree, pinned.tree);
  const back = setFloatPinned(pinned.tree, leafId, false);
  assert.equal(floatOf(back.tree, leafId)?.pinned, undefined);
  assert.equal(setFloatPinned(tree, 'nope', true).refused, 'unknownTarget');
});

test('what is pinned is written to the zone, what is not stays in the view, nothing in both', () => {
  const { tree, leafId } = viewWithPopup('a');
  const pinned = setFloatPinned(tree, leafId, true).tree;
  const withOwn = openFloat(pinned, term('own'), box).tree;
  const { view, ambient } = splitAmbient(withOwn);
  assert.equal(ambient.floats.length, 1);
  assert.equal(ambient.floats[0]!.leaf.id, leafId);
  assert.equal(view.floats?.length, 1);
  assert.notEqual(view.floats![0]!.leaf.id, leafId);
});

test('another view shows the zone\'s popups next to its own, and the zone follows it', () => {
  const { tree, leafId } = viewWithPopup('a');
  const { ambient } = splitAmbient(setFloatPinned(tree, leafId, true).tree);
  const elsewhere = openFloat(defaultIslandTree(), term('here'), box).tree;
  const shown = mergeAmbient(elsewhere, ambient);
  assert.equal(shown.floats?.length, 2);
  assert.equal(floatOf(shown, leafId)?.pinned, true);
  // Merging twice shows nothing twice.
  assert.equal(mergeAmbient(shown, ambient).floats?.length, 2);
  // Unpinned there, it stays in that view only: the zone loses it.
  const unpinned = setFloatPinned(shown, leafId, false).tree;
  assert.equal(splitAmbient(unpinned).ambient.floats.length, 0);
  assert.equal(splitAmbient(unpinned).view.floats?.length, 2);
});

test('a stored zone is read without trust and never holds the route', () => {
  assert.deepEqual(readAmbient(null), emptyAmbient());
  assert.deepEqual(readAmbient({ v: 2, floats: [] }), emptyAmbient());
  const { tree, leafId } = viewWithPopup();
  const stored = JSON.parse(JSON.stringify(splitAmbient(setFloatPinned(tree, leafId, true).tree).ambient));
  stored.floats[0].leaf.tabs.push({ id: 'rr', content: { type: HOST_ROUTE, params: {} } });
  stored.floats.push({ leaf: 'junk', rect: box });
  const read = readAmbient(stored);
  assert.equal(read.floats.length, 1);
  assert.equal(read.floats[0]!.pinned, true);
  assert.equal(read.floats[0]!.leaf.tabs.some((t) => t.content.type === HOST_ROUTE), false);
  assert.ok(read.floats.length <= MAX_FLOATS);
});

test('a pinned popup folded on one view stays folded on the next', () => {
  const { tree, leafId } = viewWithPopup('a');
  const folded = setFloatMinimized(setFloatPinned(tree, leafId, true).tree, leafId, true).tree;
  const { ambient } = splitAmbient(folded);
  const stored = readAmbient(JSON.parse(JSON.stringify(ambient)));
  assert.equal(stored.floats[0]?.minimized, true);
  const otherView = mergeAmbient(defaultIslandTree(), stored);
  assert.equal(floatOf(otherView, leafId)?.minimized, true);
  assert.equal(floatOf(otherView, leafId)?.pinned, true);
});
