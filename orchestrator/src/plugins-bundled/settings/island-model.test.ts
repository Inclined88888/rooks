/**
 * The daemon's copy of the island engine's bounds, and the validation of a
 * proposal. The vector below is pinned on the app's side too
 * (`app/src/lib/island-proposals.test.ts`): if one side moves, both fail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_ROUTE,
  ISLAND_LIMITS,
  nestingDepth,
  parseIslandsProposal,
  pluginOfType,
  presetStoredTree,
  readStoredTree,
  storedDepth,
  validateIslandsProposal,
  type StoredIslandSnapshot,
} from './island-model.js';

test('the bounds and the reserved type are the engine\'s', () => {
  assert.deepEqual(ISLAND_LIMITS, { islands: 8, depth: 3, tabsPerIsland: 12, tabs: 32, paramsBytes: 1024 });
  assert.equal(HOST_ROUTE, 'host:route');
  assert.equal(pluginOfType('@timon/terminal-web:session'), '@timon/terminal-web');
  assert.equal(pluginOfType('host:route'), null);
  assert.equal(pluginOfType('nocolon'), null);
});

test('a stored tree is read without trust: junk is the default tree, a bad tab is dropped', () => {
  assert.equal(readStoredTree(null).customised, false);
  assert.equal(readStoredTree({ v: 2, root: {} }).customised, false);
  const tree = readStoredTree({
    v: 1, focus: 'gone',
    root: { id: 's', kind: 'split', dir: 'column', ratios: [3, 'x'], children: [
      { id: 'a', kind: 'leaf', active: 'ta', tabs: [{ id: 'ta', content: { type: 'host:route' } }, { id: 'BAD', content: { type: 'x:y' } }] },
      { id: 'b', kind: 'leaf', tabs: [{ id: 'tb', content: { type: 'x:y', params: { deep: { no: 1 } } } }] },
    ] },
  });
  assert.equal(tree.customised, true);
  // The second island lost its only tab: the split collapses to the first.
  assert.equal(tree.root.kind, 'leaf');
  assert.equal(tree.focus, 'a');
  assert.equal(storedDepth(tree.root), 0);
});

test('nesting is measured without recursion', () => {
  let deep: unknown = 1;
  for (let i = 0; i < 10_000; i++) deep = [deep];
  assert.ok(nestingDepth(deep) > 64);
  assert.equal(parseIslandsProposal({ view: '/', layout: { root: deep } }), null);
});

const snapshot: StoredIslandSnapshot = {
  at: 1,
  types: [{ type: '@acme/board:board', title: 'Board', params: {
    id: { type: 'string', required: true, maxLength: 8 },
    zoom: { type: 'number', min: 1, max: 4 },
    mode: { type: 'string', enum: ['a', 'b'] },
  } }],
};
const current = readStoredTree(null);
const ctx = { snapshot, current, allowed: (p: string) => p === '@acme/board' };
const codes = (body: unknown) => {
  const parsed = parseIslandsProposal({ view: '/', ...(body as object) });
  assert.ok(parsed?.success, JSON.stringify(parsed?.error?.issues));
  return validateIslandsProposal(parsed.data, ctx).problems.map((p) => p.code);
};
const board = (params: Record<string, unknown>) => ({ type: '@acme/board:board', params });

test('params are checked against what the type declares', () => {
  assert.deepEqual(codes({ open: { content: board({ id: 'q3', zoom: 2, mode: 'a' }), edge: 'right' } }), []);
  assert.deepEqual(codes({ open: { content: board({}), edge: 'right' } }), ['invalid_params']);
  assert.deepEqual(codes({ open: { content: board({ id: 'toolongid' }), edge: 'right' } }), ['invalid_params']);
  assert.deepEqual(codes({ open: { content: board({ id: 'q', zoom: 9 }), edge: 'right' } }), ['invalid_params']);
  assert.deepEqual(codes({ open: { content: board({ id: 'q', mode: 'c' }), edge: 'right' } }), ['invalid_params']);
  assert.deepEqual(codes({ open: { content: board({ id: 'q', zoom: '2' }), edge: 'right' } }), ['invalid_params']);
  assert.deepEqual(codes({ open: { content: board({ id: 'q', other: 1 }), edge: 'right' } }), ['invalid_params']);
});

test('the built-in browser, as its client half declares it, needs an agent', () => {
  const browser: StoredIslandSnapshot = { at: 1, types: [{ type: '@timon/browser-embedded:view', title: 'Browser', params: {
    agent: { type: 'string', required: true, maxLength: 128 },
    mission: { type: 'string', nullable: true, maxLength: 64 },
    display: { type: 'string', enum: ['auto', 'mobile', 'desktop'] },
  } }] };
  const check = (params: Record<string, unknown> | undefined) => {
    const parsed = parseIslandsProposal({ view: '/', open: { content: { type: '@timon/browser-embedded:view', ...(params ? { params } : {}) }, edge: 'right' } });
    assert.ok(parsed?.success);
    return validateIslandsProposal(parsed.data, { snapshot: browser, current, allowed: () => true }).problems.map((p) => p.code);
  };
  assert.deepEqual(check(undefined), ['invalid_params']);
  assert.deepEqual(check({ agent: 'timon.coder', mission: null, display: 'auto' }), []);
  assert.deepEqual(check({ agent: 'timon.coder', display: 'tv' }), ['invalid_params']);
});

test('a type that declares no params is let through with a warning, not silently', () => {
  const bare: StoredIslandSnapshot = { at: 1, types: [{ type: '@acme/bare:view', title: 'Bare' }] };
  const parsed = parseIslandsProposal({ view: '/', open: { content: { type: '@acme/bare:view' }, edge: 'right' } });
  assert.ok(parsed?.success);
  const result = validateIslandsProposal(parsed.data, { snapshot: bare, current, allowed: () => true });
  assert.deepEqual(result.problems, []);
  assert.match(result.warnings.join('\n'), /declares no params/);
});

test('a layout holds the page exactly once, within the bounds', () => {
  const route = { tabs: [{ type: HOST_ROUTE }] };
  const leaf = { tabs: [board({ id: 'q' })] };
  assert.deepEqual(codes({ layout: { root: { dir: 'row', children: [route, leaf] } } }), []);
  assert.deepEqual(codes({ layout: { root: { dir: 'row', children: [route, route] } } }), ['route_tab']);
  assert.deepEqual(codes({ layout: { root: { dir: 'row', children: [route, leaf], ratios: [1] } } }), ['invalid_ratios']);
  assert.deepEqual(codes({ layout: { root: { dir: 'row', children: [route, leaf] }, focus: [1] } }), []);
  assert.deepEqual(codes({ layout: { root: { dir: 'row', children: [route, leaf] }, focus: [3] } }), ['invalid_focus']);
  assert.deepEqual(codes({ layout: { root: { tabs: [{ type: HOST_ROUTE }, board({ id: 'q' })], active: 4 } } }), ['invalid_active']);
  const tabs = Array.from({ length: 12 }, () => board({ id: 'q' }));
  const many = { dir: 'row', children: [route, { tabs }, { tabs }, { tabs }] };
  assert.deepEqual(codes({ layout: { root: many } }), ['max_tabs']);
  assert.equal(parseIslandsProposal({ view: '/', layout: { root: { tabs: [...tabs, board({ id: 'q' })] } } })?.success, false, '13 tabs in an island');
});

test('an `open` deepens the tree only against a crossing edge', () => {
  const stored = readStoredTree({
    v: 1, focus: 'c',
    root: { id: 's1', kind: 'split', dir: 'row', ratios: [0.5, 0.5], children: [
      { id: 'a', kind: 'leaf', active: 'ta', tabs: [{ id: 'ta', content: { type: HOST_ROUTE } }] },
      { id: 's2', kind: 'split', dir: 'column', ratios: [0.5, 0.5], children: [
        { id: 'b', kind: 'leaf', active: 'tb', tabs: [{ id: 'tb', content: board({ id: 'b' }) }] },
        { id: 's3', kind: 'split', dir: 'row', ratios: [0.5, 0.5], children: [
          { id: 'c', kind: 'leaf', active: 'tc', tabs: [{ id: 'tc', content: board({ id: 'c' }) }] },
          { id: 'd', kind: 'leaf', active: 'td', tabs: [{ id: 'td', content: board({ id: 'd' }) }] },
        ] },
      ] },
    ] },
  });
  assert.equal(storedDepth(stored.root), 3);
  const deepCtx = { ...ctx, current: stored };
  const check = (open: object) => {
    const parsed = parseIslandsProposal({ view: '/', open });
    assert.ok(parsed?.success);
    return validateIslandsProposal(parsed.data, deepCtx).problems.map((p) => p.code);
  };
  assert.deepEqual(check({ content: board({ id: 'e' }), edge: 'right', island: 'c' }), []);
  assert.deepEqual(check({ content: board({ id: 'e' }), edge: 'bottom', island: 'c' }), ['max_depth']);
  assert.deepEqual(check({ content: board({ id: 'e' }), edge: 'center', island: 'c' }), []);
  // No island named: the focused one, `c`.
  assert.deepEqual(check({ content: board({ id: 'e' }), edge: 'top' }), ['max_depth']);
});

test('without a snapshot, nothing can be checked', () => {
  const parsed = parseIslandsProposal({ view: '/', open: { content: board({ id: 'q' }), edge: 'right' } });
  assert.ok(parsed?.success);
  assert.deepEqual(validateIslandsProposal(parsed.data, { ...ctx, snapshot: null }).problems.map((p) => p.code), ['no_snapshot']);
});

test('a param key is any 1 to 64 characters, as in the engine', () => {
  const dashed: StoredIslandSnapshot = { at: 1, types: [{ type: '@acme/board:board', title: 'Board', params: { 'board-id': { type: 'string', required: true } } }] };
  const parsed = parseIslandsProposal({ view: '/', open: { content: { type: '@acme/board:board', params: { 'board-id': 'q3' } }, edge: 'right' } });
  assert.ok(parsed?.success);
  assert.deepEqual(validateIslandsProposal(parsed.data, { ...ctx, snapshot: dashed }).problems, []);
  assert.equal(parseIslandsProposal({ view: '/', open: { content: { type: 'a:b', params: { ['x'.repeat(65)]: 1 } }, edge: 'right' } })?.success, false);
  assert.equal(parseIslandsProposal({ view: '/', open: { content: { type: 'a:b', params: { 'a\nb': 1 } }, edge: 'right' } })?.success, false);
});

test('a preset drops the volatile params of each tab, in the tree and in the popups, and nothing else', () => {
  const types = [
    { type: '@timon/terminal-web:session', title: 'Terminal', volatileParams: ['sessionId', 'fresh'] },
    { type: '@acme/x:view', title: 'X' },
  ];
  const term = (id: string) => ({ id, content: { type: '@timon/terminal-web:session', params: { scope: 'project:p', sessionId: `s-${id}` } } });
  const raw = {
    v: 1, focus: 'a', extra: 'kept',
    root: { id: 'sp', kind: 'split', dir: 'row', ratios: [0.5, 0.5], children: [
      { id: 'a', kind: 'leaf', active: 'r', tabs: [{ id: 'r', content: { type: HOST_ROUTE, params: {} } }, term('t1')] },
      { id: 'b', kind: 'leaf', active: 'x', tabs: [{ id: 'x', content: { type: '@acme/x:view', params: { sessionId: 'not volatile here' } } }] },
    ] },
    floats: [{ rect: { x: 0, y: 0, width: 0.3, height: 0.3 }, leaf: { id: 'f', kind: 'leaf', active: 't2', tabs: [term('t2')] } }],
  };
  const out = presetStoredTree(raw, types) as typeof raw;
  const [left, right] = out.root.children;
  assert.deepEqual(left!.tabs[1]!.content.params, { scope: 'project:p' });
  assert.deepEqual(right!.tabs[0]!.content.params, { sessionId: 'not volatile here' });
  assert.deepEqual(out.floats[0]!.leaf.tabs[0]!.content.params, { scope: 'project:p' });
  assert.equal(out.extra, 'kept');
  assert.equal(raw.root.children[0]!.tabs[1]!.content.params.sessionId, 's-t1', 'the stored row is not mutated');
  assert.equal(presetStoredTree(raw, []), raw, 'no declaration, no change');
  assert.equal(presetStoredTree('junk', types), 'junk');
});
