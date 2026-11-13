import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addTab,
  collectLeaves,
  floatOf,
  floatRectAt,
  defaultIslandTree,
  insertAt,
  insertAtRoot,
  layoutRects,
  ISLAND_LIMITS,
  type IslandContent,
  type IslandNode,
  type IslandTree,
} from './island-tree';
import {
  dropLabelKey,
  dropPreviewRect,
  islandDropTargetAt,
  windowSnapEdgeAt,
  windowSnapEdgesAt,
  windowSnapTargetAt,
  planIslandDrop,
  rootPreviewRect,
  sameDropTarget,
  tabInsertIndex,
  type ResolvedContent,
} from './island-drop';

const TERM = '@rooks/terminal-web:session';
const term = (sessionId: string): IslandContent => ({ type: TERM, params: { sessionId } });

/** The registry as the workspace would answer it: terminals only, one tab per session. */
function resolve(content: IslandContent): ResolvedContent | null {
  if (content.type !== TERM || typeof content.params.sessionId !== 'string') return null;
  return { content, options: { existing: (other) => other.params.sessionId === content.params.sessionId } };
}

function shape(node: IslandNode): string {
  if (node.kind === 'leaf') {
    return node.tabs.map((tab) => (tab.content.type === 'host:route' ? 'route' : String(tab.content.params.sessionId))).join('+');
  }
  return `${node.dir}(${node.children.map(shape).join(',')})`;
}

function ok(plan: { tree: IslandTree; refused: unknown }): IslandTree {
  assert.equal(plan.refused, null);
  return plan.tree;
}

const leafIds = (tree: IslandTree) => collectLeaves(tree.root).map((leaf) => leaf.id);

test('a content dropped on the four edges and the centre of an island: column, stack, tab', () => {
  const base = defaultIslandTree();
  const route = leafIds(base)[0]!;
  const at = (region: 'left' | 'right' | 'top' | 'bottom' | 'center') =>
    shape(ok(planIslandDrop(base, { kind: 'content', content: term('a') }, { kind: 'island', islandId: route, region }, resolve)).root);
  assert.equal(at('right'), 'row(route,a)');
  assert.equal(at('left'), 'row(a,route)');
  assert.equal(at('bottom'), 'column(route,a)');
  assert.equal(at('top'), 'column(a,route)');
  assert.equal(at('center'), 'route+a');
});

test('a content no type takes is refused, and so is one past the limits', () => {
  const base = defaultIslandTree();
  const route = leafIds(base)[0]!;
  const unknown = planIslandDrop(base, { kind: 'content', content: { type: 'acme:x', params: {} } }, { kind: 'island', islandId: route, region: 'right' }, resolve);
  assert.equal(unknown.refused, 'unknownType');
  assert.equal(unknown.tree, base, 'the tree is untouched');
  let full = base;
  for (let i = 0; i < ISLAND_LIMITS.islands - 1; i += 1) full = ok(insertAtRoot(full, 'right', term(`c${i}`)));
  const over = planIslandDrop(full, { kind: 'content', content: term('x') }, { kind: 'root', edge: 'left' }, resolve);
  assert.equal(over.refused, 'maxIslands');
});

test('a singleton content already open moves instead of opening twice', () => {
  const base = defaultIslandTree();
  const route = leafIds(base)[0]!;
  const one = ok(insertAt(base, route, 'right', term('a')));
  const moved = ok(planIslandDrop(one, { kind: 'content', content: term('a') }, { kind: 'island', islandId: route, region: 'bottom' }, resolve));
  assert.equal(shape(moved.root), 'column(route,a)');
});

test('a tab dragged to an edge founds an island; to the centre of another it joins it; to a band, a full column', () => {
  const base = defaultIslandTree();
  const route = leafIds(base)[0]!;
  // route | a+b
  const split = ok(insertAt(base, route, 'right', term('a')));
  const right = leafIds(split)[1]!;
  const tabs = ok(addTab(split, right, term('b')));
  const b = collectLeaves(tabs.root)[1]!.tabs[1]!.id;
  assert.equal(shape(ok(planIslandDrop(tabs, { kind: 'tab', tabId: b }, { kind: 'island', islandId: route, region: 'bottom' }, resolve)).root), 'row(column(route,b),a)');
  assert.equal(shape(ok(planIslandDrop(tabs, { kind: 'tab', tabId: b }, { kind: 'island', islandId: route, region: 'center' }, resolve)).root), 'row(route+b,a)');
  assert.equal(shape(ok(planIslandDrop(tabs, { kind: 'tab', tabId: b }, { kind: 'island', islandId: route, region: 'center', index: 0 }, resolve)).root), 'row(b+route,a)');
  assert.equal(shape(ok(planIslandDrop(tabs, { kind: 'tab', tabId: b }, { kind: 'root', edge: 'left' }, resolve)).root), 'row(b,route,a)');
  // Reordered within its own island, through the tab bar.
  assert.equal(shape(ok(planIslandDrop(tabs, { kind: 'tab', tabId: b }, { kind: 'island', islandId: right, region: 'center', index: 0 }, resolve)).root), 'row(route,b+a)');
});

test('a drop that would change nothing is refused as "self"', () => {
  const base = defaultIslandTree();
  const route = leafIds(base)[0]!;
  const split = ok(insertAt(base, route, 'right', term('a')));
  const right = leafIds(split)[1]!;
  const aTab = collectLeaves(split.root)[1]!.tabs[0]!.id;
  // The only tab of an island, against its own island.
  assert.equal(planIslandDrop(split, { kind: 'tab', tabId: aTab }, { kind: 'island', islandId: right, region: 'left' }, resolve).refused, 'self');
  // Back on its own body.
  assert.equal(planIslandDrop(split, { kind: 'tab', tabId: aTab }, { kind: 'island', islandId: right, region: 'center' }, resolve).refused, 'self');
  // An island on itself, whatever the region.
  for (const region of ['left', 'center', 'bottom'] as const) {
    assert.equal(planIslandDrop(split, { kind: 'island', islandId: right }, { kind: 'island', islandId: right, region }, resolve).refused, 'self');
  }
  // Already the last column: the band on its side changes nothing.
  assert.equal(planIslandDrop(split, { kind: 'island', islandId: right }, { kind: 'root', edge: 'right' }, resolve).refused, 'self');
  // The only island of the view has nowhere to go.
  assert.equal(planIslandDrop(base, { kind: 'island', islandId: route }, { kind: 'root', edge: 'left' }, resolve).refused, 'self');
});

test('a whole island: against an edge it moves, in the centre its tabs join the target', () => {
  const base = defaultIslandTree();
  const route = leafIds(base)[0]!;
  const split = ok(insertAt(base, route, 'right', term('a')));
  const right = leafIds(split)[1]!;
  const moved = ok(planIslandDrop(split, { kind: 'island', islandId: right }, { kind: 'island', islandId: route, region: 'top' }, resolve));
  assert.equal(shape(moved.root), 'column(a,route)');
  assert.ok(leafIds(moved).includes(right), 'it keeps its id');
  const merged = ok(planIslandDrop(split, { kind: 'island', islandId: right }, { kind: 'island', islandId: route, region: 'center' }, resolve));
  assert.equal(shape(merged.root), 'route+a');
});

test('the target under the pointer: bands first, the tab bar is a tab, the body has edges, a gutter has nothing', () => {
  const base = defaultIslandTree();
  const route = leafIds(base)[0]!;
  const split = ok(insertAt(base, route, 'right', term('a')));
  const box = { x: 0, y: 0, width: 1008, height: 600 };
  const layout = layoutRects(split, box, 8);
  const [left, right] = leafIds(split) as [string, string];
  const options = { headerPx: 32, rootBand: 24, tabIndexAt: () => 1 };
  assert.deepEqual(islandDropTargetAt(layout, box, 10, 300, options), { kind: 'root', edge: 'left' });
  assert.deepEqual(islandDropTargetAt(layout, box, 500, 590, options), { kind: 'root', edge: 'bottom' });
  assert.deepEqual(islandDropTargetAt(layout, box, 250, 3, options), { kind: 'root', edge: 'top' }, 'a sliver above the tab bars');
  assert.deepEqual(islandDropTargetAt(layout, box, 250, 12, options), { kind: 'island', islandId: left, region: 'center', index: 1 }, 'the tab bar wins below it');
  assert.deepEqual(islandDropTargetAt(layout, box, 250, 40, options), { kind: 'island', islandId: left, region: 'top' }, 'just under the header');
  assert.deepEqual(islandDropTargetAt(layout, box, 250, 30, options), { kind: 'island', islandId: left, region: 'center', index: 1 }, 'over the tab bar');
  assert.deepEqual(islandDropTargetAt(layout, box, 250, 300, options), { kind: 'island', islandId: left, region: 'center' });
  assert.deepEqual(islandDropTargetAt(layout, box, 480, 300, options), { kind: 'island', islandId: left, region: 'right' });
  assert.deepEqual(islandDropTargetAt(layout, box, 560, 300, options), { kind: 'island', islandId: right, region: 'left' });
  assert.equal(islandDropTargetAt(layout, box, 503, 300, options), null, 'the gutter');
  assert.equal(islandDropTargetAt(layout, box, 2000, 300, options), null, 'outside');
  // One island, no header and no band: the frame itself, by its regions.
  const single = layoutRects(base, box, 8);
  assert.deepEqual(islandDropTargetAt(single, box, 5, 300, { headerPx: 0, rootBand: 0 }), { kind: 'island', islandId: route, region: 'left' });
});

test('a tab lands after the tabs whose middle is left of the pointer, the dragged one left out', () => {
  const tabs = [{ id: 'a', left: 0, width: 100 }, { id: 'b', left: 100, width: 100 }, { id: 'c', left: 200, width: 100 }];
  assert.equal(tabInsertIndex(tabs, 10), 0);
  assert.equal(tabInsertIndex(tabs, 160), 2);
  assert.equal(tabInsertIndex(tabs, 400), 3);
  // `a` dragged past `b`: its final place is 1, not 2.
  assert.equal(tabInsertIndex(tabs, 160, 'a'), 1);
});

test('the preview covers the place the content will take', () => {
  const rect = { x: 100, y: 0, width: 400, height: 300 };
  assert.deepEqual(dropPreviewRect(rect, 'right', 32), { x: 300, y: 0, width: 200, height: 300 });
  assert.deepEqual(dropPreviewRect(rect, 'top', 32), { x: 100, y: 0, width: 400, height: 150 });
  assert.deepEqual(dropPreviewRect(rect, 'center', 32), { x: 100, y: 32, width: 400, height: 268 }, 'the body, under the tab bar');
  const base = defaultIslandTree();
  const box = { x: 0, y: 0, width: 900, height: 600 };
  assert.deepEqual(rootPreviewRect(base, box, 'left'), { x: 0, y: 0, width: 450, height: 600 });
  const two = ok(insertAtRoot(base, 'right', term('a')));
  assert.deepEqual(rootPreviewRect(two, box, 'right'), { x: 600, y: 0, width: 300, height: 600 }, 'one more third of the row');
  assert.deepEqual(rootPreviewRect(two, box, 'bottom'), { x: 0, y: 300, width: 900, height: 300 });
});

test('labels and target identity', () => {
  assert.equal(dropLabelKey({ kind: 'root', edge: 'left' }), 'islands.drop.root.left');
  assert.equal(dropLabelKey({ kind: 'island', islandId: 'x', region: 'center' }), 'islands.drop.center');
  assert.ok(sameDropTarget({ kind: 'island', islandId: 'x', region: 'left' }, { kind: 'island', islandId: 'x', region: 'left' }));
  assert.ok(!sameDropTarget({ kind: 'island', islandId: 'x', region: 'center', index: 1 }, { kind: 'island', islandId: 'x', region: 'center', index: 2 }));
  assert.ok(!sameDropTarget({ kind: 'root', edge: 'left' }, null));
});

// ---------------------------------------------------------------- popups

const point = floatRectAt(0.5, 0.5);

test('a content dropped with no island named opens as a popup, and an open one moves out', () => {
  const base = defaultIslandTree();
  const popup = ok(planIslandDrop(base, { kind: 'content', content: term('a') }, { kind: 'float', rect: point }, resolve));
  assert.equal(popup.floats?.length, 1);
  assert.equal(shape(popup.root), 'route');
  const open = ok(planIslandDrop(base, { kind: 'content', content: term('b') }, { kind: 'island', islandId: leafIds(base)[0]!, region: 'right' }, resolve));
  const moved = ok(planIslandDrop(open, { kind: 'content', content: term('b') }, { kind: 'float', rect: point }, resolve));
  assert.equal(moved.floats?.length, 1);
  assert.equal(shape(moved.root), 'route');
});

test('a tab or an island dropped with no island named becomes a popup; a popup keeps its size', () => {
  const base = ok(insertAtRoot(defaultIslandTree(), 'right', term('a')));
  const leaf = collectLeaves(base.root).find((l) => l.tabs[0]?.content.type !== 'host:route')!;
  const asIsland = ok(planIslandDrop(base, { kind: 'island', islandId: leaf.id }, { kind: 'float', rect: point }, resolve));
  assert.equal(floatOf(asIsland, leaf.id)?.rect.width, point.width);
  const resized = { ...floatOf(asIsland, leaf.id)!.rect, width: 0.7 };
  const big = { ...asIsland, floats: [{ ...asIsland.floats![0]!, rect: resized }] };
  const moved = ok(planIslandDrop(big, { kind: 'island', islandId: leaf.id }, { kind: 'float', rect: floatRectAt(0.3, 0.3) }, resolve));
  assert.equal(floatOf(moved, leaf.id)?.rect.width, 0.7);
  const asTab = ok(planIslandDrop(base, { kind: 'tab', tabId: leaf.tabs[0]!.id }, { kind: 'float', rect: point }, resolve));
  assert.equal(asTab.floats?.length, 1);
});

test('the route\'s island cannot become a popup', () => {
  const base = defaultIslandTree();
  const plan = planIslandDrop(base, { kind: 'island', islandId: leafIds(base)[0]! }, { kind: 'float', rect: point }, resolve);
  assert.equal(plan.refused, 'routeTab');
});

test('a popup answers before what is under it, with its centre only', () => {
  const base = ok(insertAtRoot(defaultIslandTree(), 'right', term('a')));
  const leaf = collectLeaves(base.root).find((l) => l.tabs[0]?.content.type !== 'host:route')!;
  const popup = ok(planIslandDrop(base, { kind: 'island', islandId: leaf.id }, { kind: 'float', rect: point }, resolve));
  const box = { x: 0, y: 0, width: 1000, height: 600 };
  const layout = layoutRects(popup, box, 8);
  const rect = floatOf(popup, leaf.id)!.rect;
  const islands = { ...layout.islands, [leaf.id]: { x: rect.x * 1000, y: rect.y * 600, width: rect.width * 1000, height: rect.height * 600 } };
  const hit = islandDropTargetAt({ ...layout, islands }, box, rect.x * 1000 + 3, rect.y * 600 + 100, {
    headerPx: 32,
    rootBand: 24,
    floatIds: new Set([leaf.id]),
  });
  assert.deepEqual(hit, { kind: 'island', islandId: leaf.id, region: 'center', index: undefined });
});

test('popup targets: same place is the same target, and the pill has its own label', () => {
  assert.equal(sameDropTarget({ kind: 'float', rect: point }, { kind: 'float', rect: { ...point, x: point.x + 0.001 } }), true);
  assert.equal(sameDropTarget({ kind: 'float', rect: point }, { kind: 'float', rect: { ...point, x: point.x + 0.2 } }), false);
  assert.equal(dropLabelKey({ kind: 'float', rect: point }), 'islands.drop.float');
});

test('a window moved by its handle docks only against the screen\'s border', () => {
  const view = { width: 1440, height: 900 };
  assert.equal(windowSnapEdgeAt(720, 450, view), null, 'the middle of the page: nothing');
  assert.equal(windowSnapEdgeAt(200, 450, view), null, 'near a split, far from the border: nothing');
  assert.equal(windowSnapEdgeAt(4, 450, view), 'left');
  assert.equal(windowSnapEdgeAt(1439, 450, view), 'right');
  assert.equal(windowSnapEdgeAt(720, 2, view), 'top');
  assert.equal(windowSnapEdgeAt(720, 890, view), 'bottom');
  assert.equal(windowSnapEdgeAt(2, 10, view), 'left', 'a corner: the nearest edge');
  assert.equal(windowSnapEdgeAt(-30, 450, view), 'left', 'a pointer past the border still counts');
  assert.equal(windowSnapEdgeAt(4, 450, { width: 0, height: 0 }), null);
});

test('along a screen edge: the column under the pointer, the whole workspace around the middle', () => {
  const box = { x: 0, y: 0, width: 1200, height: 800 };
  const layout = { islands: { page: { x: 0, y: 0, width: 596, height: 800 }, term: { x: 604, y: 0, width: 596, height: 800 }, pop: { x: 300, y: 300, width: 400, height: 400 } }, gutters: [] };
  const popups = new Set(['pop']);
  assert.deepEqual(windowSnapTargetAt(layout, box, 'bottom', 1150, popups), { kind: 'island', islandId: 'term', region: 'bottom' }, 'under the right column');
  assert.deepEqual(windowSnapTargetAt(layout, box, 'bottom', 50, popups), { kind: 'island', islandId: 'page', region: 'bottom' });
  assert.deepEqual(windowSnapTargetAt(layout, box, 'bottom', 600, popups), { kind: 'root', edge: 'bottom' }, 'the middle: the whole workspace');
  assert.deepEqual(windowSnapTargetAt(layout, box, 'right', 400, popups), { kind: 'root', edge: 'right' }, 'one island along that edge: the whole workspace');
  assert.deepEqual(windowSnapTargetAt(layout, box, 'bottom', 1500, popups), { kind: 'island', islandId: 'term', region: 'bottom' }, 'past the box: its end');
  assert.deepEqual(windowSnapEdgesAt(1190, 795, { width: 1200, height: 800 }), ['bottom', 'right'], 'a corner: both, nearest first');
});
