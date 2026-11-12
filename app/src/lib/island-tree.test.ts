import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resizeFloatRect,
  setSplitRatios,
  withIslandIds,
  sameContentAs,
  HOST_ROUTE,
  ISLAND_LIMITS,
  MAX_FLOATS,
  allLeaves,
  floatLeaf,
  floatOf,
  floatTab,
  findLeaf,
  focusLeaf,
  activateTab,
  addTab,
  closeTab,
  collectLeaves,
  defaultIslandTree,
  dropRegionAt,
  equalizeAt,
  expandIslandFromGrid,
  findTab,
  fitsMinimums,
  insertAt,
  newIslandId,
  insertAtRoot,
  isDefaultIslandTree,
  layoutRects,
  minimizedFloats,
  openFloat,
  setFloatMinimized,
  setTabParams,
  routeParams,
  setRouteParams,
  setFloatPinned,
  setLeafGlassScope,
  shownIslandTree,
  leafOfTab,
  mergeLeaf,
  minFractions,
  moveLeaf,
  moveLeafToRoot,
  moveTab,
  moveTabToRoot,
  normalizeIslandTree,
  readIslandTree,
  removeLeaf,
  resizeAt,
  sanitizeParams,
  splitDepth,
  splitTab,
  treeFromGrid,
  type IslandContent,
  type IslandNode,
  type IslandSplit,
  type IslandTree,
} from './island-tree';

const term = (sessionId: string): IslandContent => ({ type: '@rooks/terminal-web:session', params: { sessionId } });

function rootLeafId(tree: IslandTree): string {
  return collectLeaves(tree.root)[0]!.id;
}

/** A compact picture of the tree: `row(route,T1)`, tabs of a leaf joined by `+`. */
function shape(node: IslandNode): string {
  if (node.kind === 'leaf') {
    return node.tabs.map((tab) => (tab.content.type === HOST_ROUTE ? 'route' : String(tab.content.params.sessionId))).join('+');
  }
  return `${node.dir}(${node.children.map(shape).join(',')})`;
}

function ok(result: { tree: IslandTree; refused: unknown }): IslandTree {
  assert.equal(result.refused, null);
  return result.tree;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

test('the default tree is one island with the route tab, and is recognised as such', () => {
  const tree = defaultIslandTree();
  assert.equal(shape(tree.root), 'route');
  assert.ok(isDefaultIslandTree(tree));
  assert.equal(tree.focus, tree.root.id);
  assert.match(tree.root.id, /^[a-z0-9]{8}$/);
});

test('insertAt right of a lone island makes two columns at 50/50, and focuses the new one', () => {
  // An unknown target is refused, not guessed.
  assert.equal(insertAt(defaultIslandTree(), 'nope', 'right', term('a')).refused, 'unknownTarget');
  const base = defaultIslandTree();
  const next = ok(insertAt(base, rootLeafId(base), 'right', term('a')));
  assert.equal(shape(next.root), 'row(route,a)');
  assert.deepEqual((next.root as IslandSplit).ratios, [0.5, 0.5]);
  assert.equal(next.focus, collectLeaves(next.root)[1]!.id);
  assert.ok(!isDefaultIslandTree(next));
});

test('left/top insert before the target; top/bottom stack', () => {
  const base = defaultIslandTree();
  assert.equal(shape(ok(insertAt(base, rootLeafId(base), 'left', term('a'))).root), 'row(a,route)');
  assert.equal(shape(ok(insertAt(base, rootLeafId(base), 'top', term('a'))).root), 'column(a,route)');
  assert.equal(shape(ok(insertAt(base, rootLeafId(base), 'bottom', term('a'))).root), 'column(route,a)');
});

test('a third column halves only its target: neighbours keep their size', () => {
  const base = defaultIslandTree();
  const two = ok(insertAt(base, rootLeafId(base), 'right', term('a')));
  const aId = collectLeaves(two.root)[1]!.id;
  const three = ok(insertAt(two, aId, 'right', term('b')));
  assert.equal(shape(three.root), 'row(route,a,b)');
  assert.deepEqual((three.root as IslandSplit).ratios, [0.5, 0.25, 0.25]);
});

test('right of an island already in a stack splits that island only (Q1 bis)', () => {
  const base = defaultIslandTree();
  const stacked = ok(insertAt(base, rootLeafId(base), 'bottom', term('a')));
  const aId = collectLeaves(stacked.root)[1]!.id;
  const next = ok(insertAt(stacked, aId, 'right', term('b')));
  assert.equal(shape(next.root), 'column(route,row(a,b))');
  assert.equal(splitDepth(next.root), 2);
});

test('insertAtRoot gives a full-height column, at any depth of the tree', () => {
  const base = defaultIslandTree();
  const stacked = ok(insertAt(base, rootLeafId(base), 'bottom', term('a')));
  const next = ok(insertAtRoot(stacked, 'right', term('b')));
  assert.equal(shape(next.root), 'row(column(route,a),b)');
  const more = ok(insertAtRoot(next, 'left', term('c')));
  assert.equal(shape(more.root), 'row(c,column(route,a),b)');
  const ratios = (more.root as IslandSplit).ratios;
  assert.ok(Math.abs(sum(ratios) - 1) < 1e-9);
  assert.ok(Math.abs(ratios[0]! - 1 / 3) < 1e-9);
});

test('a tab or an island dropped on an edge band of the workspace becomes a full-height column', () => {
  const base = defaultIslandTree();
  const stacked = ok(insertAt(base, rootLeafId(base), 'bottom', term('a')));
  const aLeaf = collectLeaves(stacked.root)[1]!;
  const withTab = ok(addTab(stacked, aLeaf.id, term('b')));
  const bTab = collectLeaves(withTab.root)[1]!.tabs[1]!;
  // A tab among others leaves its island and founds one along the edge.
  const tabMoved = ok(moveTabToRoot(withTab, bTab.id, 'right'));
  assert.equal(shape(tabMoved.root), 'row(column(route,a),b)');
  assert.equal(leafOfTab(tabMoved, bTab.id)!.tabs[0]!.id, bTab.id, 'the tab keeps its id');
  // The only tab of its island: the island moves, and keeps its id.
  const leafMoved = ok(moveTabToRoot(stacked, aLeaf.tabs[0]!.id, 'left'));
  assert.equal(shape(leafMoved.root), 'row(a,route)');
  assert.equal(collectLeaves(leafMoved.root)[0]!.id, aLeaf.id);
  assert.equal(leafMoved.focus, aLeaf.id);
  // Whole island, same thing; alone in the tree, it stays.
  assert.equal(shape(ok(moveLeafToRoot(stacked, aLeaf.id, 'right')).root), 'row(route,a)');
  assert.equal(moveLeafToRoot(base, rootLeafId(base), 'right').tree, base);
});

test('addTab appends and activates; at an index it inserts there', () => {
  const base = defaultIslandTree();
  const leafId = rootLeafId(base);
  const one = ok(addTab(base, leafId, term('a')));
  assert.equal(shape(one.root), 'route+a');
  const leaf = collectLeaves(one.root)[0]!;
  assert.equal(leaf.active, leaf.tabs[1]!.id);
  const two = ok(addTab(one, leafId, term('b'), 0));
  assert.equal(shape(two.root), 'b+route+a');
  assert.ok(!isDefaultIslandTree(one));
});

test('an already open content is moved, not duplicated (singleton)', () => {
  const base = defaultIslandTree();
  const one = ok(insertAt(base, rootLeafId(base), 'right', term('a')));
  const same = { existing: (c: IslandContent) => c.params.sessionId === 'a' };
  const moved = ok(addTab(one, rootLeafId(one), term('a'), undefined, same));
  assert.equal(shape(moved.root), 'route+a');
  const split = ok(insertAt(moved, rootLeafId(moved), 'bottom', term('a'), same));
  assert.equal(shape(split.root), 'column(route,a)');
  const tabId = findTab(moved, '@rooks/terminal-web:session', (p) => p.sessionId === 'a')!.tabId;
  assert.equal(findTab(split, '@rooks/terminal-web:session')!.tabId, tabId, 'the tab keeps its id');
});

test('moveTab reorders within an island and moves across, closing an emptied island', () => {
  const base = defaultIslandTree();
  const leafId = rootLeafId(base);
  let tree = ok(addTab(base, leafId, term('a')));
  tree = ok(addTab(tree, leafId, term('b')));
  const routeTab = collectLeaves(tree.root)[0]!.tabs[0]!.id;
  tree = ok(moveTab(tree, routeTab, leafId, 2));
  assert.equal(shape(tree.root), 'a+b+route');
  const bTab = findTab(tree, '@rooks/terminal-web:session', (p) => p.sessionId === 'b')!.tabId;
  tree = ok(splitTab(tree, bTab, leafId, 'right'));
  assert.equal(shape(tree.root), 'row(a+route,b)');
  const bLeaf = leafOfTab(tree, bTab)!.id;
  const aTab = findTab(tree, '@rooks/terminal-web:session', (p) => p.sessionId === 'a')!.tabId;
  tree = ok(moveTab(tree, bTab, leafId));
  assert.equal(shape(tree.root), 'a+route+b');
  assert.equal(leafOfTab(tree, bTab)!.id, leafId);
  assert.equal(collectLeaves(tree.root).some((l) => l.id === bLeaf), false);
  assert.ok(aTab);
});

test('splitTab of an island\'s only tab against itself changes nothing', () => {
  const base = defaultIslandTree();
  const one = ok(insertAt(base, rootLeafId(base), 'right', term('a')));
  const aTab = findTab(one, '@rooks/terminal-web:session')!.tabId;
  const aLeaf = leafOfTab(one, aTab)!.id;
  assert.equal(splitTab(one, aTab, aLeaf, 'left').tree, one);
});

test('moveLeaf keeps the island id and its tabs; onto itself it is a no-op', () => {
  const base = defaultIslandTree();
  let tree = ok(insertAt(base, rootLeafId(base), 'right', term('a')));
  const aLeaf = collectLeaves(tree.root)[1]!.id;
  tree = ok(addTab(tree, aLeaf, term('b')));
  const moved = ok(moveLeaf(tree, aLeaf, rootLeafId(tree), 'top'));
  assert.equal(shape(moved.root), 'column(a+b,route)');
  assert.equal(collectLeaves(moved.root)[0]!.id, aLeaf);
  assert.equal(moveLeaf(moved, aLeaf, aLeaf, 'left').tree, moved);
});

test('mergeLeaf appends the source tabs to the target and keeps its active tab', () => {
  const base = defaultIslandTree();
  let tree = ok(insertAt(base, rootLeafId(base), 'right', term('a')));
  const aLeaf = collectLeaves(tree.root)[1]!.id;
  tree = ok(addTab(tree, aLeaf, term('b')));
  const aTab = findTab(tree, '@rooks/terminal-web:session', (p) => p.sessionId === 'a')!.tabId;
  tree = ok(activateTab(tree, aTab));
  const merged = ok(mergeLeaf(tree, aLeaf, rootLeafId(tree)));
  assert.equal(shape(merged.root), 'route+a+b');
  assert.equal(collectLeaves(merged.root)[0]!.active, aTab);
});

test('closeTab activates the neighbour, closes an emptied island, and never closes the route', () => {
  const base = defaultIslandTree();
  const leafId = rootLeafId(base);
  let tree = ok(addTab(base, leafId, term('a')));
  tree = ok(addTab(tree, leafId, term('b')));
  const aTab = findTab(tree, '@rooks/terminal-web:session', (p) => p.sessionId === 'a')!.tabId;
  const bTab = findTab(tree, '@rooks/terminal-web:session', (p) => p.sessionId === 'b')!.tabId;
  tree = ok(activateTab(tree, aTab));
  tree = ok(closeTab(tree, aTab));
  assert.equal(collectLeaves(tree.root)[0]!.active, bTab, 'the tab after the closed one');
  const routeTab = collectLeaves(tree.root)[0]!.tabs[0]!.id;
  assert.equal(closeTab(tree, routeTab).refused, 'routeTab');
  const split = ok(splitTab(tree, bTab, leafId, 'right'));
  const back = ok(closeTab(split, bTab));
  assert.ok(isDefaultIslandTree(back), 'closing the last added island is the default again');
});

test('removeLeaf gives the place back pro rata, and is refused for the route island', () => {
  const base = defaultIslandTree();
  let tree = ok(insertAt(base, rootLeafId(base), 'right', term('a')));
  const aLeaf = collectLeaves(tree.root)[1]!.id;
  tree = ok(insertAt(tree, aLeaf, 'right', term('b')));
  const removed = ok(removeLeaf(tree, aLeaf));
  assert.equal(shape(removed.root), 'row(route,b)');
  const ratios = (removed.root as IslandSplit).ratios;
  assert.ok(Math.abs(ratios[0]! - 2 / 3) < 1e-9 && Math.abs(ratios[1]! - 1 / 3) < 1e-9);
  assert.equal(removeLeaf(tree, rootLeafId(tree)).refused, 'routeTab');
});

test('resizeAt moves one boundary, clamped by the minimum fractions', () => {
  const base = defaultIslandTree();
  const tree = ok(insertAt(base, rootLeafId(base), 'right', term('a')));
  const splitId = tree.root.id;
  const moved = ok(resizeAt(tree, splitId, 0, 0.2));
  assert.deepEqual((moved.root as IslandSplit).ratios.map((r) => Math.round(r * 100)), [70, 30]);
  const clamped = ok(resizeAt(tree, splitId, 0, 0.9, [0.1, 0.25]));
  assert.deepEqual((clamped.root as IslandSplit).ratios.map((r) => Math.round(r * 100)), [75, 25]);
  const low = ok(resizeAt(tree, splitId, 0, -0.9, 0.2));
  assert.deepEqual((low.root as IslandSplit).ratios.map((r) => Math.round(r * 100)), [20, 80]);
  assert.equal(resizeAt(tree, splitId, 1, 0.1).refused, 'unknownTarget');
  assert.equal(moved.root.id, splitId, 'a split keeps its id through a resize');
  const even = ok(equalizeAt(moved, splitId, 0));
  assert.deepEqual((even.root as IslandSplit).ratios, [0.5, 0.5]);
});

test('limits: 8 islands, 3 split levels, 12 tabs per island, 32 in all — refusal leaves the tree untouched', () => {
  let tree = defaultIslandTree();
  for (let i = 0; i < ISLAND_LIMITS.islands - 1; i += 1) tree = ok(insertAtRoot(tree, 'right', term(`c${i}`)));
  assert.equal(collectLeaves(tree.root).length, 8);
  const refused = insertAtRoot(tree, 'right', term('x'));
  assert.equal(refused.refused, 'maxIslands');
  assert.equal(refused.tree, tree);

  let deep = defaultIslandTree();
  let target = rootLeafId(deep);
  const edges = ['right', 'bottom', 'right'] as const;
  for (const [i, edge] of edges.entries()) {
    deep = ok(insertAt(deep, target, edge, term(`d${i}`)));
    target = collectLeaves(deep.root).at(-1)!.id;
  }
  assert.equal(splitDepth(deep.root), 3);
  assert.equal(insertAt(deep, target, 'bottom', term('x')).refused, 'maxDepth');

  let tabs = defaultIslandTree();
  const leafId = rootLeafId(tabs);
  for (let i = 0; i < ISLAND_LIMITS.tabsPerIsland - 1; i += 1) tabs = ok(addTab(tabs, leafId, term(`t${i}`)));
  assert.equal(addTab(tabs, leafId, term('x')).refused, 'maxTabsPerIsland');

  let many = defaultIslandTree();
  for (let i = 0; i < 3; i += 1) many = ok(insertAtRoot(many, 'right', term(`r${i}`)));
  for (const leaf of collectLeaves(many.root)) {
    while (collectLeaves(many.root).find((l) => l.id === leaf.id)!.tabs.length < 8) {
      many = ok(addTab(many, leaf.id, term(`m${Math.random()}`)));
    }
  }
  assert.equal(addTab(many, rootLeafId(many), term('x')).refused, 'maxTabs');
});

test('normalize: one-child splits collapse, same-direction splits flatten, ratios renormalise', () => {
  const tab = (id: string, sessionId: string) => ({ id, content: term(sessionId) });
  const leaf = (id: string, tabs = [tab(`t${id}`, id)]) => ({ id, kind: 'leaf' as const, tabs, active: tabs[0]!.id });
  const tree: IslandTree = {
    v: 1,
    focus: 'gone',
    root: {
      id: 'r', kind: 'split', dir: 'row', ratios: [1, 1],
      children: [
        { id: 's1', kind: 'split', dir: 'row', ratios: [1, 3], children: [leaf('a'), leaf('b')] },
        { id: 's2', kind: 'split', dir: 'column', ratios: [5], children: [leaf('c')] },
      ],
    },
  };
  const out = normalizeIslandTree(tree);
  // The route tab missing: one is added in the first island.
  assert.equal(shape(out.root), 'row(route+a,b,c)');
  assert.deepEqual((out.root as IslandSplit).ratios, [0.125, 0.375, 0.5]);
  assert.equal(out.focus, 'a', 'focus falls back on the route island');
});

test('normalize: duplicate ids and a second route tab are dropped; bad ratios become equal parts', () => {
  const route = (id: string) => ({ id, content: { type: HOST_ROUTE, params: {} } });
  const tree: IslandTree = {
    v: 1,
    focus: null,
    root: {
      id: 'r', kind: 'split', dir: 'column', ratios: [0, Number.NaN, 2],
      children: [
        { id: 'a', kind: 'leaf', tabs: [route('t1'), { id: 't2', content: term('x') }], active: 'zz' },
        { id: 'b', kind: 'leaf', tabs: [route('t3'), { id: 't2', content: term('y') }], active: 't3' },
        { id: 'a', kind: 'leaf', tabs: [{ id: 't4', content: term('z') }], active: 't4' },
      ],
    },
  };
  const out = normalizeIslandTree(tree);
  assert.equal(shape(out.root), 'route+x');
  assert.equal(collectLeaves(out.root)[0]!.active, 't1');
});

test('readIslandTree: garbage is the default tree, a stored tree comes back intact', () => {
  for (const raw of [null, 42, 'x', [], { v: 2 }, { v: 1, root: { kind: 'nope' } }]) {
    assert.ok(isDefaultIslandTree(readIslandTree(raw)));
  }
  const base = defaultIslandTree();
  const stored = ok(insertAt(base, rootLeafId(base), 'right', { type: '@acme/crm:board', params: { id: 'q3' } }));
  const back = readIslandTree(JSON.parse(JSON.stringify(stored)));
  assert.deepEqual(back, stored);
});

test('readIslandTree keeps a tab whose type is unknown, but drops one with unreadable params', () => {
  const raw = {
    v: 1, focus: 'a',
    root: { id: 'a', kind: 'leaf', active: 't1', tabs: [
      { id: 't1', content: { type: HOST_ROUTE, params: {} } },
      { id: 't2', content: { type: '@gone/plugin:view', params: { deep: { no: 1 }, ok: 'yes' } } },
      { id: 't3', content: { type: '@acme/x:y', params: { big: 'x'.repeat(2000) } } },
      { id: 't4', content: { type: 'bad type with spaces', params: {} } },
    ] },
  };
  const tree = readIslandTree(raw);
  const leaf = collectLeaves(tree.root)[0]!;
  assert.deepEqual(leaf.tabs.map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(leaf.tabs[1]!.content.params, { ok: 'yes' });
});

test('sanitizeParams keeps flat primitives under 1 KiB', () => {
  assert.deepEqual(sanitizeParams({ a: 1, b: 'x', c: true, d: null, e: [1], f: {}, g: Number.NaN }), { a: 1, b: 'x', c: true, d: null });
  assert.equal(sanitizeParams([1]), null);
  assert.equal(sanitizeParams({ s: 'x'.repeat(1100) }), null);
  assert.deepEqual(sanitizeParams(undefined), {});
});

test('layoutRects: islands and gutters tile the box exactly', () => {
  const base = defaultIslandTree();
  let tree = ok(insertAt(base, rootLeafId(base), 'right', term('a')));
  const aLeaf = collectLeaves(tree.root)[1]!.id;
  tree = ok(insertAt(tree, aLeaf, 'bottom', term('b')));
  const layout = layoutRects(tree, { x: 0, y: 0, width: 1008, height: 608 }, 8);
  const [route, a, b] = collectLeaves(tree.root).map((l) => layout.islands[l.id]!);
  assert.deepEqual(route, { x: 0, y: 0, width: 500, height: 608 });
  assert.deepEqual(a, { x: 508, y: 0, width: 500, height: 300 });
  assert.deepEqual(b, { x: 508, y: 308, width: 500, height: 300 });
  assert.equal(layout.gutters.length, 2);
  assert.deepEqual(layout.gutters[0]!.rect, { x: 500, y: 0, width: 8, height: 608 });
  assert.deepEqual(layout.gutters[1]!.rect, { x: 508, y: 300, width: 500, height: 8 });
});

test('fitsMinimums and minFractions follow each island\'s minimum', () => {
  const base = defaultIslandTree();
  const tree = ok(insertAt(base, rootLeafId(base), 'right', term('a')));
  const minOf = () => ({ width: 280, height: 160 });
  assert.ok(fitsMinimums(tree, { width: 568, height: 160 }, 8, minOf));
  assert.ok(!fitsMinimums(tree, { width: 567, height: 600 }, 8, minOf));
  const fractions = minFractions(tree.root as IslandSplit, 1008, 8, minOf);
  assert.deepEqual(fractions, [0.28, 0.28]);
});

test('dropRegionAt: 30 % edge bands, centre elsewhere, nearest edge in a corner', () => {
  const rect = { x: 100, y: 100, width: 200, height: 100 };
  assert.equal(dropRegionAt(rect, 200, 150), 'center');
  assert.equal(dropRegionAt(rect, 159, 150), 'left');
  assert.equal(dropRegionAt(rect, 160, 150), 'center', 'the band is strict');
  assert.equal(dropRegionAt(rect, 241, 150), 'right');
  assert.equal(dropRegionAt(rect, 200, 129), 'top');
  assert.equal(dropRegionAt(rect, 200, 171), 'bottom');
  assert.equal(dropRegionAt(rect, 105, 120), 'left', '5 px from the left, 20 from the top');
  assert.equal(dropRegionAt(rect, 140, 102), 'top', '40 px from the left, 2 from the top');
  assert.equal(dropRegionAt(rect, 110, 110), 'left', 'a tie goes to left/right');
});

const chat = (agent: string): IslandContent => ({ type: '@rooks/missions:chat', params: { agent, missionId: null, fresh: false } });
const route = (): IslandContent => ({ type: HOST_ROUTE, params: {} });
/** The tree's shape, ids left out: `[dir, ratios, children]` for a split, the agent (or route) for a leaf. */
const gridShape = (node: IslandNode): unknown => node.kind === 'leaf'
  ? node.tabs.map((tab) => (tab.content.type === HOST_ROUTE ? 'route' : tab.content.params.agent))
  : [node.dir, node.ratios, node.children.map(gridShape)];
const built = (result: ReturnType<typeof treeFromGrid>): IslandTree => {
  assert.equal(result.refused, null);
  return result.tree!;
};

test('treeFromGrid: a 2 × 2 grid is a row of two columns, cells read row by row', () => {
  const tree = built(treeFromGrid({ cols: 2, rows: 2 }, [route(), chat('b'), chat('c'), chat('d')]));
  assert.deepEqual(gridShape(tree.root), ['row', [0.5, 0.5], [
    ['column', [0.5, 0.5], [['route'], ['c']]],
    ['column', [0.5, 0.5], [['b'], ['d']]],
  ]]);
  const routeLeaf = collectLeaves(tree.root).find((leaf) => leaf.tabs[0]!.content.type === HOST_ROUTE)!;
  assert.equal(tree.focus, routeLeaf.id, 'the route island has the focus');
  assert.equal(splitDepth(tree.root), 2);
});

test('treeFromGrid: one row is a row of islands, one column a column of islands', () => {
  assert.deepEqual(gridShape(built(treeFromGrid({ cols: 3, rows: 1 }, [route(), chat('b'), chat('c')])).root),
    ['row', [1 / 3, 1 / 3, 1 / 3], [['route'], ['b'], ['c']]]);
  assert.deepEqual(gridShape(built(treeFromGrid({ cols: 1, rows: 2 }, [route(), chat('b')])).root),
    ['column', [0.5, 0.5], [['route'], ['b']]]);
});

test('treeFromGrid: empty cells leave no island, an empty column leaves no column', () => {
  const tree = built(treeFromGrid({ cols: 3, rows: 2 }, [route(), null, chat('c'), chat('d'), null, null]));
  assert.deepEqual(gridShape(tree.root), ['row', [0.5, 0.5], [
    ['column', [0.5, 0.5], [['route'], ['d']]],
    ['c'],
  ]]);
  // A content storage would refuse is an empty cell too.
  const bad = built(treeFromGrid({ cols: 2, rows: 1 }, [route(), { type: 'not a type', params: {} }]));
  assert.deepEqual(gridShape(bad.root), ['route']);
});

test('treeFromGrid: without a route cell, the route opens in the first island', () => {
  const tree = built(treeFromGrid({ cols: 2, rows: 1 }, [chat('a'), chat('b')]));
  assert.deepEqual(gridShape(tree.root), ['row', [0.5, 0.5], [['route', 'a'], ['b']]]);
  const routes = collectLeaves(tree.root).flatMap((leaf) => leaf.tabs).filter((tab) => tab.content.type === HOST_ROUTE);
  assert.equal(routes.length, 1);
});

test('treeFromGrid: an empty grid, or more cells than islands, is refused', () => {
  assert.deepEqual(treeFromGrid({ cols: 2, rows: 2 }, [null, null, null, null]), { tree: null, refused: 'empty' });
  const nine = [route(), ...'abcdefgh'.split('').map(chat)];
  assert.equal(nine.length, ISLAND_LIMITS.islands + 1);
  assert.deepEqual(treeFromGrid({ cols: 3, rows: 3 }, nine), { tree: null, refused: 'maxIslands' });
  // Eight of nine cells fit.
  const eight = built(treeFromGrid({ cols: 3, rows: 3 }, [...nine.slice(0, 8), null]));
  assert.equal(collectLeaves(eight.root).length, ISLAND_LIMITS.islands);
});

test('treeFromGrid: the tree survives a stored round trip unchanged', () => {
  const tree = built(treeFromGrid({ cols: 2, rows: 2 }, [route(), chat('b'), null, chat('d')]));
  const ids = [...collectLeaves(tree.root).flatMap((leaf) => [leaf.id, ...leaf.tabs.map((tab) => tab.id)])];
  for (const id of ids) assert.match(id, /^[a-z0-9]{1,16}$/);
  assert.deepEqual(readIslandTree(JSON.parse(JSON.stringify(tree))), tree);
});

test('treeFromGrid: malformed dimensions cannot cause unbounded work', () => {
  for (const cols of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(treeFromGrid({ cols, rows: 2 }, [chat('a')]), { tree: null, refused: 'empty' });
    assert.deepEqual(treeFromGrid({ cols: 2, rows: cols }, [chat('a')]), { tree: null, refused: 'empty' });
  }
});

test('expanding a route into a grid preserves existing tabs, neighbours and their ids', () => {
  const base = defaultIslandTree();
  const routeId = base.root.id;
  const tabbed = ok(addTab(base, routeId, term('shared')));
  const existing = ok(insertAt(tabbed, routeId, 'right', term('neighbour')));
  const expanded = ok(expandIslandFromGrid(existing, routeId, { cols: 2, rows: 2 }, [chat('a'), chat('b'), chat('c'), chat('d')]));
  const leaves = collectLeaves(expanded.root);
  assert.equal(leaves.length, 5);
  for (const tab of collectLeaves(existing.root).flatMap((leaf) => leaf.tabs)) {
    assert.deepEqual(leaves.flatMap((leaf) => leaf.tabs).find((item) => item.id === tab.id), tab);
  }
  const first = leaves[0]!;
  assert.equal(first.tabs.find((tab) => tab.id === first.active)?.content.params.agent, 'a', 'the chat is active, the grid stays available as a tab');
  assert.equal(expanded.focus, first.id);
  assert.equal(leaves.at(-1)!.id, collectLeaves(existing.root).at(-1)!.id, 'the neighbour is not remounted');
});

test('a grid expansion exceeding the combined island limit is refused atomically', () => {
  const base = defaultIslandTree();
  const existing = ok(insertAt(base, base.root.id, 'right', term('neighbour')));
  const result = expandIslandFromGrid(existing, base.root.id, { cols: 4, rows: 2 }, 'abcdefgh'.split('').map(chat));
  assert.equal(result.refused, 'maxIslands');
  assert.equal(result.tree, existing);
});

// ---------------------------------------------------------------- popups (floats)

const box = { x: 0.3, y: 0.2, width: 0.4, height: 0.5 };

/** The route's island, then a terminal beside it. */
function withTerminal(id = 'a'): { tree: IslandTree; leafId: string; tabId: string } {
  const tree = ok(insertAtRoot(defaultIslandTree(), 'right', term(id)));
  const leaf = collectLeaves(tree.root).find((l) => l.tabs[0]?.content.type !== HOST_ROUTE)!;
  return { tree, leafId: leaf.id, tabId: leaf.tabs[0]!.id };
}

test('floatLeaf lifts an island out of the tree into a popup, rect kept as fractions', () => {
  const { tree, leafId } = withTerminal();
  const next = ok(floatLeaf(tree, leafId, box));
  assert.equal(shape(next.root), 'route');
  assert.deepEqual(floatOf(next, leafId)?.rect, box);
  assert.equal(next.focus, leafId);
  assert.equal(allLeaves(next).length, 2);
});

test('the route\'s island never floats', () => {
  const { tree } = withTerminal();
  const routeLeaf = collectLeaves(tree.root).find((l) => l.tabs[0]?.content.type === HOST_ROUTE)!;
  assert.equal(floatLeaf(tree, routeLeaf.id, box).refused, 'routeTab');
});

test('a popup rect is clamped inside the box and above a minimum size', () => {
  const { tree, leafId } = withTerminal();
  const next = ok(floatLeaf(tree, leafId, { x: 0.9, y: -3, width: 0.8, height: 0.01 }));
  const rect = floatOf(next, leafId)!.rect;
  assert.ok(rect.x + rect.width <= 1 && rect.x >= 0 && rect.y >= 0);
  assert.ok(rect.height >= 0.15 && rect.width <= 1);
});

test('floating an already floating island moves it, and counts once', () => {
  const { tree, leafId } = withTerminal();
  const a = ok(floatLeaf(tree, leafId, box));
  const b = ok(floatLeaf(a, leafId, { ...box, x: 0.1 }));
  assert.equal(b.floats?.length, 1);
  assert.equal(floatOf(b, leafId)?.rect.x, 0.1);
});

test('floatTab pulls one tab out of a stack into its own popup', () => {
  const { tree, leafId } = withTerminal('a');
  const stacked = ok(addTab(tree, leafId, term('b')));
  const second = findLeaf(stacked, leafId)!.tabs[1]!.id;
  const next = ok(floatTab(stacked, second, box));
  assert.equal(findLeaf(next, leafId)!.tabs.length, 1);
  assert.equal(next.floats?.length, 1);
  assert.equal(next.floats![0]!.leaf.tabs[0]!.id, second);
});

test('dropping a popup on an edge of a tree island docks it back', () => {
  const { tree, leafId } = withTerminal();
  const floated = ok(floatLeaf(tree, leafId, box));
  const route = collectLeaves(floated.root)[0]!.id;
  const docked = ok(moveLeaf(floated, leafId, route, 'bottom'));
  assert.equal(docked.floats, undefined);
  assert.equal(shape(docked.root), 'column(route,a)');
});

test('a popup takes tabs by its centre, never by its sides', () => {
  const { tree, leafId } = withTerminal('a');
  const floated = ok(floatLeaf(tree, leafId, box));
  assert.equal(insertAt(floated, leafId, 'right', term('b')).refused, 'floatEdge');
  const joined = ok(addTab(floated, leafId, term('b')));
  assert.equal(floatOf(joined, leafId)?.leaf.tabs.length, 2);
  const route = collectLeaves(joined.root)[0]!;
  assert.equal(splitTab(joined, route.tabs[0]!.id, leafId, 'left').refused, 'floatEdge');
});

test('the route tab cannot be moved into a popup', () => {
  const { tree, leafId } = withTerminal();
  const floated = ok(floatLeaf(tree, leafId, box));
  const routeTab = collectLeaves(floated.root)[0]!.tabs[0]!.id;
  assert.equal(moveTab(floated, routeTab, leafId).refused, 'routeTab');
  assert.equal(floatTab(floated, routeTab, box).refused, 'routeTab');
});

test('closing a popup\'s last tab closes the popup; activating a tab in one focuses it', () => {
  const { tree, leafId, tabId } = withTerminal();
  const floated = ok(floatLeaf(tree, leafId, box));
  const focused = ok(activateTab(floated, tabId));
  assert.equal(focused.focus, leafId);
  const closed = ok(closeTab(floated, tabId));
  assert.equal(closed.floats, undefined);
});

test('removeLeaf closes a popup', () => {
  const { tree, leafId } = withTerminal();
  const closed = ok(removeLeaf(ok(floatLeaf(tree, leafId, box)), leafId));
  assert.equal(allLeaves(closed).length, 1);
});

test('popups are capped, and count among the islands', () => {
  let tree = defaultIslandTree();
  for (let i = 0; i < MAX_FLOATS; i += 1) {
    const r = insertAtRoot(tree, 'right', term(`t${i}`));
    tree = ok(r);
    const leaf = collectLeaves(tree.root).find((l) => l.tabs[0]?.content.params.sessionId === `t${i}`)!;
    tree = ok(floatLeaf(tree, leaf.id, box));
  }
  assert.equal(tree.floats?.length, MAX_FLOATS);
  const more = ok(insertAtRoot(tree, 'right', term('extra')));
  const extra = collectLeaves(more.root).find((l) => l.tabs[0]?.content.params.sessionId === 'extra')!;
  assert.equal(floatLeaf(more, extra.id, box).refused, 'maxFloats');
});

test('a stored tree keeps its popups, drops unreadable ones and never lets the route float', () => {
  const { tree, leafId } = withTerminal();
  const floated = ok(floatLeaf(tree, leafId, box));
  const read = readIslandTree(JSON.parse(JSON.stringify(floated)));
  assert.equal(read.floats?.length, 1);
  assert.deepEqual(read.floats![0]!.rect, box);
  const hostile = JSON.parse(JSON.stringify(floated));
  hostile.floats.push({ leaf: 'nope', rect: box }, { leaf: hostile.floats[0].leaf, rect: { x: 'a' } });
  hostile.floats[0].leaf.tabs.push({ id: 'zz', content: { type: HOST_ROUTE, params: {} } });
  const cleaned = readIslandTree(hostile);
  assert.equal(cleaned.floats?.length, 1);
  assert.equal(cleaned.floats![0]!.leaf.tabs.some((t) => t.content.type === HOST_ROUTE), false);
});

test('a popup resizes from any edge or corner, the opposite sides staying put', () => {
  const origin = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  const se = resizeFloatRect(origin, { s: true, e: true }, 0.1, 0.1);
  assert.ok(near(se.x, 0.2) && near(se.width, 0.5) && near(se.height, 0.5));
  const nw = resizeFloatRect(origin, { n: true, w: true }, -0.1, -0.1);
  assert.ok(near(nw.x, 0.1) && near(nw.y, 0.1) && near(nw.x + nw.width, 0.6) && near(nw.y + nw.height, 0.6));
  const w = resizeFloatRect(origin, { w: true }, 0.5, 0.3);
  assert.ok(near(w.x + w.width, 0.6) && near(w.width, 0.15), 'the smallest size, the right side unmoved');
  assert.ok(near(w.y, 0.2) && near(w.height, 0.4), 'an edge moves one axis only');
  const n = resizeFloatRect(origin, { n: true }, 0, -1);
  assert.ok(near(n.y, 0) && near(n.y + n.height, 0.6), 'stopped at the workspace\'s border');
});

// ---------------------------------------------------------------- folded popups

test('a popup folds into the corner and comes back where it was, on top, its tabs intact', () => {
  const { tree, leafId } = withTerminal('a');
  const floated = ok(addTab(ok(floatLeaf(tree, leafId, box)), leafId, term('b')));
  const other = ok(openFloat(floated, term('c'), { x: 0, y: 0, width: 0.3, height: 0.3 }));
  const folded = ok(setFloatMinimized(other, leafId, true));
  assert.equal(floatOf(folded, leafId)?.minimized, true);
  assert.deepEqual(floatOf(folded, leafId)?.rect, box, 'its place is kept');
  assert.equal(findLeaf(folded, leafId)?.tabs.length, 2, 'its tabs are kept');
  assert.deepEqual(minimizedFloats(folded).map((f) => f.leaf.id), [leafId]);
  const back = ok(setFloatMinimized(folded, leafId, false));
  assert.equal(floatOf(back, leafId)?.minimized, undefined);
  assert.deepEqual(floatOf(back, leafId)?.rect, box, 'the same place');
  assert.equal(back.focus, leafId, 'the focused popup is the top one');
  assert.equal(setFloatMinimized(back, leafId, false).tree, back, 'already shown: nothing changes');
  assert.equal(setFloatMinimized(back, rootLeafId(back), true).refused, 'unknownTarget', 'only a popup folds');
});

test('folding the focused popup hands the focus to the route\'s island; another popup keeps it', () => {
  const { tree, leafId } = withTerminal('a');
  const floated = ok(floatLeaf(tree, leafId, box));
  assert.equal(floated.focus, leafId);
  const folded = ok(setFloatMinimized(floated, leafId, true));
  assert.equal(folded.focus, rootLeafId(folded));
  const other = ok(openFloat(floated, term('b'), box));
  const otherId = other.focus!;
  assert.equal(ok(setFloatMinimized(other, leafId, true)).focus, otherId);
});

test('the painted tree leaves folded popups out; the stored one keeps them and is never the default', () => {
  const { tree, leafId } = withTerminal('a');
  const folded = ok(setFloatMinimized(ok(floatLeaf(tree, leafId, box)), leafId, true));
  assert.equal(isDefaultIslandTree(folded), false, 'not erased from storage');
  assert.equal(isDefaultIslandTree(shownIslandTree(folded)), true, 'the page alone on screen');
  assert.equal(shownIslandTree(tree), tree, 'nothing folded: the same tree');
});

test('a gesture aimed at a folded popup unfolds it: a tab shown, added, moved in, or the popup moved', () => {
  const { tree, leafId, tabId } = withTerminal('a');
  const folded = ok(setFloatMinimized(ok(floatLeaf(tree, leafId, box)), leafId, true));
  const shown = ok(activateTab(folded, tabId));
  assert.equal(floatOf(shown, leafId)?.minimized, undefined);
  assert.equal(shown.focus, leafId);
  assert.equal(floatOf(ok(addTab(folded, leafId, term('b'))), leafId)?.minimized, undefined);
  assert.equal(floatOf(ok(focusLeaf(folded, leafId)), leafId)?.minimized, undefined);
  const reopened = ok(openFloat(folded, term('a'), box, { existing: (c) => c.params.sessionId === 'a' }));
  assert.equal(reopened.floats?.length, 1, 'the open one, not a second');
  assert.equal(floatOf(reopened, leafId)?.minimized, undefined);
  const withTab = ok(addTab(folded, rootLeafId(folded), term('b')));
  const moved = findLeaf(withTab, rootLeafId(withTab))!.tabs.at(-1)!.id;
  assert.equal(floatOf(ok(moveTab(withTab, moved, leafId)), leafId)?.minimized, undefined);
});

test('folded popups still count against the popup limit', () => {
  let tree = defaultIslandTree();
  for (let i = 0; i < MAX_FLOATS; i += 1) {
    tree = ok(openFloat(tree, term(`t${i}`), box));
    tree = ok(setFloatMinimized(tree, tree.focus!, true));
  }
  assert.equal(minimizedFloats(tree).length, MAX_FLOATS);
  assert.equal(openFloat(tree, term('extra'), box).refused, 'maxFloats');
});

test('a stored folded popup reads back folded; a forged flag is not "true"', () => {
  const { tree, leafId } = withTerminal('a');
  const folded = ok(setFloatPinned(ok(setFloatMinimized(ok(floatLeaf(tree, leafId, box)), leafId, true)), leafId, true));
  const read = readIslandTree(JSON.parse(JSON.stringify(folded)));
  assert.equal(floatOf(read, leafId)?.minimized, true);
  assert.equal(floatOf(read, leafId)?.pinned, true);
  assert.deepEqual(floatOf(read, leafId)?.rect, box);
  const forged = JSON.parse(JSON.stringify(folded));
  forged.floats[0].minimized = 'yes';
  assert.equal(floatOf(readIslandTree(forged), leafId)?.minimized, undefined);
  assert.equal(floatOf(normalizeIslandTree(folded), leafId)?.minimized, true, 'normalize keeps it');
});

test('setTabParams reaches a tab in a popup as well as one in the tree (TIM-0127)', () => {
  const docked = withTerminal('a');
  const renamed = ok(setTabParams(docked.tree, docked.tabId, { sessionId: 'a', label: 'x' }));
  assert.equal(findTab(renamed, '@rooks/terminal-web:session', (params) => params.label === 'x')?.tabId, docked.tabId);

  const floated = ok(openFloat(defaultIslandTree(), term('b'), box));
  const popupTab = allLeaves(floated).flatMap((leaf) => leaf.tabs).find((tab) => tab.content.params.sessionId === 'b')!;
  const changed = ok(setTabParams(floated, popupTab.id, { sessionId: 'b', mode: 'preview' }));
  assert.equal(changed.floats?.[0]?.leaf.tabs[0]?.content.params.mode, 'preview', 'the popup tab took the new params');
  assert.equal(setTabParams(changed, popupTab.id, { sessionId: 'b', mode: 'preview' }).tree, changed, 'same params: same tree');
  assert.equal(setTabParams(changed, 'nope', { sessionId: 'b' }).refused, 'unknownTarget');
});

test('sameContentAs: the first singleton key names the content, a refining key absent on both sides matches', () => {
  const keys = ['id', 'source', 'format'] as const;
  const skill = (params: Record<string, string>) => ({ type: 'skill', params });
  const winner = sameContentAs({ id: 'helper', mode: 'edit' }, keys);
  assert.equal(winner(skill({ id: 'helper', mode: 'preview' })), true, 'the same skill, whatever its mode');
  assert.equal(winner(skill({ id: 'helper', mode: 'preview', source: 'claude-user' })), false, 'a masked entry is another content');
  const masked = sameContentAs({ id: 'helper', source: 'claude-user', format: 'claude-skill' }, keys);
  assert.equal(masked(skill({ id: 'helper', source: 'claude-user', format: 'claude-skill', mode: 'edit' })), true);
  assert.equal(masked(skill({ id: 'helper', source: 'claude-user' })), false);
  assert.equal(sameContentAs({ mode: 'edit' }, keys)(skill({ mode: 'edit' })), false, 'without the first key, nothing is singled out');
  assert.equal(sameContentAs({ agentId: 'a', path: 'x', external: false }, ['agentId', 'path', 'external'])({ type: 'file', params: { agentId: 'a', path: 'x', external: false, mode: 'edit' } }), true);
});

// TODO #647: a gesture replayed on a rewritten tree opens its tab under the id
// it had on screen, and a gutter drag replays from the shares it started at.
test('an op run again under its recorded ids opens the same tab, on another tree', () => {
  const ids: string[] = [];
  const mine = defaultIslandTree();
  const first = withIslandIds(ids, () => insertAt(mine, mine.root.id, 'right', { type: 'x:board', params: {} }));
  assert.ok(ids.length > 0, 'the ids it minted are recorded');
  const theirs = defaultIslandTree();
  const again = withIslandIds(ids, () => insertAt(theirs, theirs.root.id, 'right', { type: 'x:board', params: {} }));
  const tabOf = (tree: IslandTree) => allLeaves(tree).flatMap((leaf) => leaf.tabs).find((tab) => tab.content.type === 'x:board')!.id;
  assert.equal(tabOf(again.tree), tabOf(first.tree));
  assert.notEqual(newIslandId(), newIslandId(), 'outside a recording, ids stay random');
});

test('a split\'s shares are set back only while it has as many children', () => {
  const base = defaultIslandTree();
  const split = insertAt(base, base.root.id, 'right', { type: 'x:board', params: {} }).tree;
  const id = split.root.id;
  const set = setSplitRatios(split, id, [0.3, 0.7]);
  assert.deepEqual(set.root.kind === 'split' ? set.root.ratios : null, [0.3, 0.7]);
  assert.equal(setSplitRatios(split, id, [0.2, 0.3, 0.5]), split);
  assert.equal(setSplitRatios(split, 'gone', [0.3, 0.7]), split);
});

// TIM-0140: the chat's page keeps the conversation of its panel in the route
// tab, which no type validates.
test('setRouteParams writes the route tab, stored and read back, the same tree when unchanged', () => {
  const base = defaultIslandTree();
  const split = ok(insertAt(base, collectLeaves(base.root)[0]!.id, 'right', term('a')));
  assert.deepEqual(routeParams(split), {});
  const kept = ok(setRouteParams(split, { view: 'kids.main', agent: 'kids.coder', missionId: 'm-coder' }));
  assert.deepEqual(routeParams(kept), { view: 'kids.main', agent: 'kids.coder', missionId: 'm-coder' });
  assert.deepEqual(routeParams(readIslandTree(JSON.parse(JSON.stringify(kept)))), routeParams(kept), 'a stored row keeps them');
  assert.equal(setRouteParams(kept, { view: 'kids.main', agent: 'kids.coder', missionId: 'm-coder' }).tree, kept);
  assert.deepEqual(routeParams(ok(setRouteParams(kept, {}))), {});
  // Kept by a page alone, they do not make the tree a stored one.
  assert.equal(isDefaultIslandTree(ok(setRouteParams(defaultIslandTree(), { view: 'kids.main' }))), true);
  assert.equal(setRouteParams(split, { big: 'x'.repeat(2000) }).refused, 'unknownTarget');
});

// --------------------------------------------------------------- glass scope

test('an island\'s glass scope is stored on its leaf and survives a round trip, docked or a popup', () => {
  const { tree, leafId } = withTerminal();
  const routeLeaf = collectLeaves(tree.root).find((l) => l.id !== leafId)!.id;
  const set = ok(setLeafGlassScope(ok(setLeafGlassScope(tree, leafId, 'widgets')), routeLeaf, 'island'));
  const read = readIslandTree(JSON.parse(JSON.stringify(set)));
  assert.equal(findLeaf(read, leafId)?.glassScope, 'widgets');
  assert.equal(findLeaf(read, routeLeaf)?.glassScope, 'island');
  // A popup keeps it too, and moving the island does not lose it.
  const floated = ok(floatLeaf(set, leafId, box));
  assert.equal(readIslandTree(JSON.parse(JSON.stringify(floated))).floats![0]!.leaf.glassScope, 'widgets');
  assert.equal(findLeaf(ok(moveLeafToRoot(floated, leafId, 'left')), leafId)?.glassScope, 'widgets');
});

test('back to the default, the field goes away; the same choice twice changes nothing', () => {
  const { tree, leafId } = withTerminal();
  const set = ok(setLeafGlassScope(tree, leafId, 'widgets'));
  assert.equal(setLeafGlassScope(set, leafId, 'widgets').tree, set, 'unchanged tree, nothing to persist');
  const back = ok(setLeafGlassScope(set, leafId, null));
  assert.equal('glassScope' in findLeaf(back, leafId)!, false);
  assert.deepEqual(JSON.parse(JSON.stringify(back)), JSON.parse(JSON.stringify(tree)));
  assert.equal(setLeafGlassScope(tree, 'nope', 'widgets').refused, 'unknownTarget');
});

test('a tree stored before the glass scope existed reads unchanged; an unknown value is dropped', () => {
  const { tree, leafId } = withTerminal();
  const old = JSON.parse(JSON.stringify(tree));
  const read = readIslandTree(old);
  assert.equal(allLeaves(read).some((l) => 'glassScope' in l), false);
  assert.deepEqual(JSON.parse(JSON.stringify(read)), old);
  const hostile = JSON.parse(JSON.stringify(tree));
  for (const leaf of [hostile.root.children[0], hostile.root.children[1]]) leaf.glassScope = 'frosted';
  assert.equal(allLeaves(readIslandTree(hostile)).some((l) => 'glassScope' in l), false);
  assert.equal(findLeaf(readIslandTree(hostile), leafId)?.glassScope, undefined);
});

test('a lone island that chose its glass is still the default view: nothing is painted around it', () => {
  const tree = defaultIslandTree();
  const set = ok(setLeafGlassScope(tree, rootLeafId(tree), 'widgets'));
  assert.equal(isDefaultIslandTree(set), true);
});
