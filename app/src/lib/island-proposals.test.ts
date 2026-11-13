/**
 * An island layout proposal applied by the owner's browser: with the drag's
 * operations, each type's own `parseParams`, and the tabs already on screen
 * kept by id. The bounds are pinned against the daemon's copy
 * (`orchestrator/src/plugins-bundled/settings/island-model.test.ts`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HOST_ROUTE,
  ISLAND_LIMITS,
  addTab,
  collectLeaves,
  defaultIslandTree,
  floatTab,
  insertAt,
  readIslandTree,
  setLeafGlassScope,
  type IslandParams,
  type IslandTree,
} from './island-tree';
import { planIslandDrop } from './island-drop';
import { applyIslandsProposal, buildIslandSnapshot, parseIslandsProposal, proposalScopes, type KnownType } from './island-proposals';

const TERMINAL = '@rooks/terminal-web:session';
const parseTerminal = (raw: unknown): IslandParams | null => {
  const p = raw as Record<string, unknown>;
  return typeof p?.sessionId === 'string' && p.sessionId ? { scope: null, sessionId: p.sessionId } : null;
};
const types = new Map<string, KnownType>([[TERMINAL, { title: 'Terminal', parseParams: parseTerminal, singletonBy: 'sessionId' }]]);
const term = (sessionId: string) => ({ type: TERMINAL, params: { sessionId } });

test('the bounds are the daemon\'s', () => {
  assert.deepEqual(ISLAND_LIMITS, { islands: 8, depth: 3, tabsPerIsland: 12, tabs: 32, paramsBytes: 1024 });
});

test('a stored payload is read again without trust', () => {
  assert.equal(parseIslandsProposal(null), null);
  assert.equal(parseIslandsProposal({ view: 'chat', open: { content: term('a'), edge: 'right' } }), null);
  assert.equal(parseIslandsProposal({ view: '/', open: { content: term('a'), edge: 'nowhere' } }), null);
  assert.deepEqual(parseIslandsProposal({ view: '/', project: '', open: { content: term('a'), edge: 'center' } }),
    { view: '/', project: null, open: { content: { type: TERMINAL, params: { sessionId: 'a' } }, edge: 'center' } });
});

test('a whole layout replaces the tree, keeping the page and the open tabs by id', () => {
  let current = defaultIslandTree();
  const routeTab = collectLeaves(current.root)[0]!.tabs[0]!.id;
  current = insertAt(current, current.focus!, 'right', { type: TERMINAL, params: { scope: null, sessionId: 's1' } }).tree;
  const termTab = collectLeaves(current.root)[1]!.tabs[0]!.id;
  const proposal = parseIslandsProposal({
    view: '/chat',
    layout: {
      root: { dir: 'column', ratios: [3, 1], children: [
        { tabs: [{ type: HOST_ROUTE }, term('s1')], active: 1 },
        { dir: 'row', children: [{ tabs: [term('s2')] }, { tabs: [{ type: '@acme/board:board', params: { id: 'q3' } }] }] },
      ] },
      focus: [1, 0],
    },
  })!;
  const out = applyIslandsProposal(proposal, current, types);
  const tree = out.tree as IslandTree;
  assert.ok(tree);
  const leaves = collectLeaves(tree.root);
  assert.equal(leaves.length, 3);
  assert.deepEqual(leaves[0]!.tabs.map((t) => t.id), [routeTab, termTab], 'the page and session s1 keep their tabs');
  assert.equal(leaves[0]!.active, termTab);
  assert.equal(tree.focus, leaves[1]!.id);
  assert.equal(tree.root.kind === 'split' && tree.root.ratios[0], 0.75);
  // An unregistered type stays, as waiting content; s2 and it are what the proposal brought.
  assert.equal(leaves[2]!.tabs[0]!.content.type, '@acme/board:board');
  assert.equal(out.added.length, 2);
  assert.deepEqual(out.dropped, []);
});

test('a layout keeps the id of an island one of its tabs came from, once', () => {
  let current = defaultIslandTree();
  const page = current.focus!;
  current = insertAt(current, page, 'right', { type: TERMINAL, params: { scope: null, sessionId: 's1' } }).tree;
  const shells = collectLeaves(current.root)[1]!.id;
  current = addTab(current, shells, { type: TERMINAL, params: { scope: null, sessionId: 's3' } }).tree;
  const proposal = parseIslandsProposal({
    view: '/',
    layout: { root: { dir: 'row', children: [{ tabs: [term('s1')] }, { tabs: [term('s3')] }, { tabs: [{ type: HOST_ROUTE }, term('s2')] }] } },
  })!;
  const tree = applyIslandsProposal(proposal, current, types).tree!;
  const ids = collectLeaves(tree.root).map((leaf) => leaf.id);
  assert.equal(ids[0], shells, 's1 keeps its island');
  assert.ok(ids[1] !== shells && ids[1] !== page, 's3 left it: a new island, never the same id twice');
  assert.equal(ids[2], page, 'the page keeps its island');
  // An `open` written against the tree before the layout still finds its island.
  const open = applyIslandsProposal(parseIslandsProposal({ view: '/', open: { content: term('s4'), edge: 'center', island: shells } })!, tree, types);
  assert.ok(open.tree);
});

test('an island that keeps its id keeps the glass its menu chose; a new one follows the default', () => {
  let current = defaultIslandTree();
  const page = current.focus!;
  current = insertAt(current, page, 'right', { type: TERMINAL, params: { scope: null, sessionId: 's1' } }).tree;
  const shells = collectLeaves(current.root)[1]!.id;
  current = setLeafGlassScope(current, shells, 'widgets').tree;
  const proposal = parseIslandsProposal({
    view: '/',
    layout: { root: { dir: 'row', children: [{ tabs: [term('s1')] }, { tabs: [term('s2')] }, { tabs: [{ type: HOST_ROUTE }] }] } },
  })!;
  const leaves = collectLeaves(applyIslandsProposal(proposal, current, types).tree!.root);
  assert.equal(leaves[0]!.id, shells);
  assert.equal(leaves[0]!.glassScope, 'widgets');
  assert.equal(leaves[1]!.glassScope, undefined);
  assert.equal(leaves[2]!.glassScope, undefined);
});

test('a whole layout keeps the popups; a popup tab the layout names moves into it', () => {
  let current = defaultIslandTree();
  const rect = { x: 0.1, y: 0.1, width: 0.4, height: 0.5 };
  const pop = (tree: IslandTree, sessionId: string, pinned = false): IslandTree => {
    const withTab = insertAt(tree, collectLeaves(tree.root)[0]!.id, 'right', { type: TERMINAL, params: { scope: null, sessionId } }).tree;
    const tab = collectLeaves(withTab.root).flatMap((l) => l.tabs).find((t) => t.content.params.sessionId === sessionId)!;
    const floated = floatTab(withTab, tab.id, rect).tree;
    if (!pinned) return floated;
    return { ...floated, floats: floated.floats!.map((f) => (f.leaf.tabs[0]!.id === tab.id ? { ...f, pinned: true } : f)) };
  };
  current = pop(current, 's1');
  current = pop(current, 's5');
  current = pop(current, 's9', true);
  const tabOf = (tree: IslandTree, sessionId: string) => tree.floats!.flatMap((f) => f.leaf.tabs).find((t) => t.content.params.sessionId === sessionId)!.id;
  const s1 = tabOf(current, 's1');
  const proposal = parseIslandsProposal({
    view: '/', layout: { root: { dir: 'row', children: [{ tabs: [{ type: HOST_ROUTE }] }, { tabs: [term('s1'), term('s9')] }] } },
  })!;
  const out = applyIslandsProposal(proposal, current, types);
  const tree = out.tree!;
  const docked = collectLeaves(tree.root).flatMap((l) => l.tabs);
  assert.ok(docked.some((t) => t.id === s1), 's1 moved out of its popup, same tab');
  const floating = (tree.floats ?? []).map((f) => f.leaf.tabs.map((t) => t.content.params.sessionId).join());
  assert.deepEqual(floating.sort(), ['s5', 's9'], 's5 stays a popup, the pinned s9 is not taken from the other views');
  assert.ok(tree.floats!.find((f) => f.leaf.tabs[0]!.content.params.sessionId === 's9')!.pinned);
});

test('a content its type refuses is left out, by title', () => {
  const proposal = parseIslandsProposal({
    view: '/', layout: { root: { dir: 'row', children: [{ tabs: [{ type: HOST_ROUTE }] }, { tabs: [{ type: TERMINAL, params: {} }] }] } },
  })!;
  const out = applyIslandsProposal(proposal, defaultIslandTree(), types);
  assert.deepEqual(out.dropped, ['Terminal']);
  assert.equal(collectLeaves(out.tree!.root).length, 1);
});

test('`open` goes through the drag\'s operations: a split, a tab, an open session moved', () => {
  const base = defaultIslandTree();
  const right = applyIslandsProposal(parseIslandsProposal({ view: '/', open: { content: term('s1'), edge: 'right' } })!, base, types);
  assert.equal(right.tree?.root.kind, 'split');
  assert.equal(right.added.length, 1);
  const tab = applyIslandsProposal(parseIslandsProposal({ view: '/', open: { content: term('s2'), edge: 'center' } })!, right.tree!, types);
  assert.equal(collectLeaves(tab.tree!.root).length, 2);
  // s1 is already open: opening it again moves its tab instead of doubling the session.
  const again = applyIslandsProposal(parseIslandsProposal({ view: '/', open: { content: term('s1'), edge: 'left' } })!, right.tree!, types);
  assert.deepEqual(again.added, []);
  assert.equal(collectLeaves(again.tree!.root).flatMap((l) => l.tabs).filter((t) => t.content.params.sessionId === 's1').length, 1);
});

test('`open` moving a content sizes the islands exactly as the same drag does', () => {
  // [page 2/3 | column(terminal, browser) 1/3], then the terminal opened left of the page.
  const current = readIslandTree({
    v: 1, focus: 'p',
    root: { id: 'row', kind: 'split', dir: 'row', ratios: [2, 1], children: [
      { id: 'p', kind: 'leaf', active: 'tp', tabs: [{ id: 'tp', content: { type: HOST_ROUTE, params: {} } }] },
      { id: 'col', kind: 'split', dir: 'column', ratios: [1, 1], children: [
        { id: 't', kind: 'leaf', active: 'tt', tabs: [{ id: 'tt', content: { type: TERMINAL, params: { scope: null, sessionId: 's1' } } }] },
        { id: 'b', kind: 'leaf', active: 'tb', tabs: [{ id: 'tb', content: { type: '@acme/board:board', params: { id: 'q3' } } }] },
      ] },
    ] },
  });
  const out = applyIslandsProposal(parseIslandsProposal({ view: '/', open: { content: term('s1'), edge: 'left', island: 'p' } })!, current, types).tree!;
  // The user's own gesture: the terminal's tab dropped on the page's left edge.
  const drag = planIslandDrop(current, { kind: 'tab', tabId: 'tt' }, { kind: 'island', islandId: 'p', region: 'left' }, () => null).tree;
  assert.ok(out.root.kind === 'split' && drag.root.kind === 'split');
  assert.deepEqual(out.root.ratios, drag.root.ratios);
  // The emptied column folds into the browser, which keeps its third; the
  // page, the target, gives half of its place to the incoming island.
  assert.deepEqual(out.root.ratios.map((r) => Math.round(r * 1000) / 1000), [0.333, 0.333, 0.333]);
  assert.deepEqual(collectLeaves(out.root).map((leaf) => leaf.tabs[0]!.id), ['tt', 'tp', 'tb']);
});

test('`open` against an island that is gone applies nothing', () => {
  const out = applyIslandsProposal(parseIslandsProposal({ view: '/', open: { content: term('s1'), edge: 'right', island: 'gone' } })!, defaultIslandTree(), types);
  assert.equal(out.tree, null);
});

test('the snapshot carries the declared params, sorted and bounded', () => {
  const snap = buildIslandSnapshot([
    { typeId: 'z:z', options: { title: 'Z' } },
    { typeId: TERMINAL, options: { title: 'Terminal', params: { sessionId: { type: 'string', required: true } }, volatileParams: ['sessionId'], singletonBy: 'sessionId' } },
  ]);
  assert.deepEqual(snap.types.map((t) => t.type), [TERMINAL, 'z:z']);
  assert.deepEqual(snap.types[0], {
    type: TERMINAL, title: 'Terminal', params: { sessionId: { type: 'string', required: true } }, volatileParams: ['sessionId'], singletonBy: 'sessionId',
  });
  assert.deepEqual(snap.types[1], { type: 'z:z', title: 'Z' });
});

test('a declaration out of bounds is cut, not lost', () => {
  const snap = buildIslandSnapshot([{ typeId: 'a:b', options: {
    title: `Board\n${'x'.repeat(200)}`,
    params: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, { type: 'string' as const, enum: Array.from({ length: 60 }, (_, j) => `v${j}`) }])),
  } }]);
  const type = snap.types[0]!;
  assert.equal(type.title.length, 120);
  assert.ok(!type.title.includes('\n'));
  assert.equal(Object.keys(type.params!).length, 32);
  assert.equal(type.params!.p0!.enum!.length, 50);
});

test('also_projects: one payload per project, with a whole layout only, deduplicated', () => {
  const layout = { root: { tabs: [{ type: 'host:route' }] } };
  const scopes = proposalScopes({ view: '/chat', project: 'demo', layout, also_projects: ['', 'demo', '../x'] }) as Array<{ project: string | null }>;
  assert.deepEqual(scopes.map((s) => s.project), ['demo', null]);
  const open = proposalScopes({ view: '/chat', project: 'demo', open: { content: { type: 'host:route' }, edge: 'left' }, also_projects: [''] });
  assert.equal(open.length, 1);
});
