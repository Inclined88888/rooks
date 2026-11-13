/**
 * A preset of islands without the day's state (`docs/ISLAND-WORKSPACE.md`
 * §4, step 13). What breaks silently: a preset that reopens yesterday's
 * conversation on every view it is applied to, and a terminal stripped of its
 * session that comes back as "content unavailable" instead of a new shell.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { HOST_ROUTE, allLeaves, readIslandTree, type IslandParams, type IslandTree } from './island-tree';
import { presetIslandTree, presetParams, type PresetContentType } from './island-presets';
import { captureScopes, hookedPreset, type LayoutPreset } from './layout-presets';

const CHAT = '@rooks/missions:chat';
const TERM = '@rooks/terminal-web:session';
const STRICT = '@acme/strict:view';

const chat: PresetContentType = {
  volatileParams: ['missionId', 'fresh'],
  parseParams: (raw) => {
    const { agent, missionId } = raw as Record<string, unknown>;
    if (typeof agent !== 'string') return null;
    return { agent, missionId: typeof missionId === 'string' ? missionId : null, fresh: false };
  },
};
const terminal: PresetContentType = {
  volatileParams: ['sessionId', 'fresh'],
  parseParams: (raw): IslandParams | null => {
    const { sessionId, scope, fresh } = raw as Record<string, unknown>;
    const s = typeof scope === 'string' ? scope : null;
    if (sessionId === undefined && fresh === true) return { scope: s, fresh: true };
    return typeof sessionId === 'string' ? { scope: s, sessionId } : null;
  },
};
// A type that needs its volatile param and knows no `fresh`.
const strict: PresetContentType = {
  volatileParams: ['token'],
  parseParams: (raw) => (typeof (raw as Record<string, unknown>).token === 'string' ? (raw as IslandParams) : null),
};
const types = new Map<string, PresetContentType>([[CHAT, chat], [TERM, terminal], [STRICT, strict]]);

const tab = (id: string, type: string, params: IslandParams) => ({ id, content: { type, params } });

function stored(): IslandTree {
  return {
    v: 1,
    focus: 'l1',
    root: {
      id: 's1', kind: 'split', dir: 'row', ratios: [0.5, 0.25, 0.25],
      children: [
        { id: 'l1', kind: 'leaf', active: 'r', tabs: [tab('r', HOST_ROUTE, {}), tab('c', CHAT, { agent: 'initech.coder', missionId: 'm-1', fresh: false })] },
        { id: 'l2', kind: 'leaf', active: 't', tabs: [tab('t', TERM, { scope: 'project:rooks', sessionId: 'sess-1' })] },
        { id: 'l3', kind: 'leaf', active: 'x', tabs: [tab('x', STRICT, { token: 'abc' })] },
      ],
    },
    floats: [{ leaf: { id: 'f1', kind: 'leaf', active: 'u', tabs: [tab('u', '@gone/plugin:thing', { missionId: 'kept' })] }, rect: { x: 0.5, y: 0.5, width: 0.3, height: 0.3 } }],
  };
}

test('presetParams: nothing volatile, the same object comes back', () => {
  const params = { agent: 'a' };
  assert.equal(presetParams(params, chat), params);
});

test('presetParams: a chat keeps its agent and forgets its conversation', () => {
  assert.deepEqual(presetParams({ agent: 'a', missionId: 'm', fresh: false }, chat), { agent: 'a' });
});

test('presetParams: a terminal without its session asks for a new shell', () => {
  assert.deepEqual(presetParams({ scope: 'project:p', sessionId: 's' }, terminal), { scope: 'project:p', fresh: true });
});

test('presetParams: a type that cannot do without its volatile param is left out', () => {
  assert.equal(presetParams({ token: 'abc' }, strict), null);
});

test('presetIslandTree: the day is dropped, the arrangement kept', () => {
  const out = readIslandTree(presetIslandTree(stored(), types));
  const tabs = allLeaves(out).flatMap((leaf) => leaf.tabs);
  assert.deepEqual(tabs.find((t) => t.id === 'c')?.content.params, { agent: 'initech.coder' });
  assert.deepEqual(tabs.find((t) => t.id === 't')?.content.params, { scope: 'project:rooks', fresh: true });
  // The strict island lost its only tab, so the island itself is gone.
  assert.equal(tabs.some((t) => t.id === 'x'), false);
  assert.equal(out.root.kind === 'split' ? out.root.children.length : 0, 2);
  // The route stays, and a type nobody registers is kept untouched.
  assert.ok(tabs.some((t) => t.content.type === HOST_ROUTE));
  assert.deepEqual(tabs.find((t) => t.id === 'u')?.content.params, { missionId: 'kept' });
});

test('presetIslandTree: absent stays absent, and a second pass changes nothing', () => {
  assert.equal(presetIslandTree(null, types), null);
  assert.equal(presetIslandTree(undefined, types), undefined);
  const once = presetIslandTree(stored(), types);
  assert.deepEqual(presetIslandTree(once, types), once);
});

test('captureScopes: the hook of a suffix applies to that row only', () => {
  const hooks = { islands: (layout: unknown) => presetIslandTree(layout, types) };
  const out = captureScopes('v2.k.', [
    { scope: 'v2.k.islands', layout: stored() },
    { scope: 'v2.k.widgets', layout: { missionId: 'not an island' } },
  ], hooks);
  assert.deepEqual(out.widgets, { missionId: 'not an island' });
  const tabs = allLeaves(readIslandTree(out.islands)).flatMap((leaf) => leaf.tabs);
  assert.equal(tabs.some((t) => 'missionId' in t.content.params && t.content.type === CHAT), false);
});

test('captureScopes: an inherited name is not a hook', () => {
  const out = captureScopes('v2.k.', [{ scope: 'v2.k.toString', layout: 1 }], {});
  assert.equal(out.toString, 1);
});

test('hookedPreset: a preset saved before the hook is cleaned at recall', () => {
  const preset: LayoutPreset = { id: 'p', name: 'Old', createdAt: 1, scopes: { islands: stored(), columns: { left: 240 } } };
  const out = hookedPreset(preset, { islands: (layout) => presetIslandTree(layout, types) });
  assert.deepEqual(out.scopes.columns, { left: 240 });
  const tabs = allLeaves(readIslandTree(out.scopes.islands)).flatMap((leaf) => leaf.tabs);
  assert.deepEqual(tabs.find((t) => t.id === 't')?.content.params, { scope: 'project:rooks', fresh: true });
  assert.equal(preset.scopes.islands !== out.scopes.islands, true, 'the stored preset is not mutated');
});

// TIM-0140: the chat's page panel keeps another agent's conversation in the
// route tab's params. A conversation never goes into a named arrangement.
test('presetIslandTree: the route tab forgets the conversation its page kept', () => {
  const tree = stored();
  if (tree.root.kind !== 'split' || tree.root.children[0]?.kind !== 'leaf') throw new Error('fixture');
  tree.root.children[0].tabs[0] = tab('r', HOST_ROUTE, { view: 'initech.main', agent: 'initech.coder', missionId: 'm-coder' });
  const out = readIslandTree(presetIslandTree(tree, types));
  const route = allLeaves(out).flatMap((leaf) => leaf.tabs).find((t) => t.content.type === HOST_ROUTE);
  assert.equal(route?.id, 'r');
  assert.deepEqual(route?.content.params, {});
});
