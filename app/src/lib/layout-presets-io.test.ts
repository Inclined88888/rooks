/**
 * Photographing a view and writing one back, against a fake daemon.
 *
 * What only shows up here: a capture that photographs the preset row itself
 * (every save would embed the previous ones, and the 64 KiB cap would be hit
 * after a handful), and a recall that writes the preset's rows without
 * erasing the ones the view holds beside them — the same click would then
 * give a different screen depending on what was on it beforehand.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureView,
  commitPresets,
  forgetPresets,
  listProjectSlugs,
  recallEverywhere,
  recallView,
  viewKeysOfAllProjects,
} from './layout-presets-io';
import { workspaceScope } from './workspace-scope';
import { saveLayout } from './ui-layout-store';
import { announceIslandWorkspace } from './island-bus';
import {
  LAYOUT_RECALLED_EVENT,
  MAX_PRESETS_BYTES,
  presetsBytes,
  type LayoutPreset,
} from './layout-presets';

const KEY = 'v2.deadbeef';

type Call = { method: string; scope: string | null };

/** A daemon holding `rows`, plus a note of every write it received. */
function daemon(rows: Record<string, unknown>, { readable = true } = {}) {
  const store: Record<string, unknown> = { ...rows };
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const scope = url.searchParams.get('scope');
    const prefix = url.searchParams.get('prefix');
    const method = init?.method ?? 'GET';
    if (method !== 'GET') calls.push({ method, scope });
    if (method === 'DELETE') { delete store[scope!]; return Response.json({ ok: true, scope }); }
    if (method === 'PUT') {
      store[scope!] = (JSON.parse(String(init!.body)) as { layout: unknown }).layout;
      return Response.json({ ok: true, scope });
    }
    if (!readable) return new Response(null, { status: 503 });
    return Response.json({ prefix, layouts: Object.entries(store)
      .filter(([s]) => s.startsWith(prefix!))
      .map(([s, layout]) => ({ scope: s, layout, updatedAt: 1 })) });
  }) as typeof globalThis.fetch;
  return { store, calls, restore() { globalThis.fetch = original; } };
}

test('a capture holds the view, stripped of its key and of the preset row', async () => {
  const d = daemon({
    [`${KEY}.widgets`]: [{ id: 'agenda' }],
    [`${KEY}.columns`]: { left: 240 },
    [`${KEY}.presets`]: { v: 1, presets: [{ id: 'p1' }] },
    // On a view without a project the shared row sits under this very prefix
    // (`workspaceScope(owner, view, null)` IS the key): capturing it would
    // photograph the whole list into every preset saved from there.
    [`${KEY}.shared-presets`]: { v: 1, presets: [{ id: 'p2' }] },
    'v2.another.widgets': [{ id: 'elsewhere' }],
  });
  try {
    assert.deepEqual(await captureView(KEY), {
      widgets: [{ id: 'agenda' }],
      columns: { left: 240 },
    });
  } finally { d.restore(); }
});

test('a daemon that cannot be read yields no arrangement rather than an empty one', async () => {
  const d = daemon({}, { readable: false });
  try {
    assert.equal(await captureView(KEY), null);
  } finally { d.restore(); }
});

test('a recall writes the preset rows and forgets the ones it does not hold', async () => {
  const preset: LayoutPreset = {
    id: 'p1', name: 'Review', createdAt: 1, scopes: { widgets: [{ id: 'agenda' }] },
  };
  const d = daemon({
    [`${KEY}.widgets`]: [{ id: 'something-else' }],
    [`${KEY}.islands`]: { v: 1 },
    [`${KEY}.nav`]: { pinned: true },
    [`${KEY}.presets`]: { v: 1, presets: [preset] },
  });
  try {
    const current = (await captureView(KEY))!;
    assert.equal(await recallView(KEY, preset, current), 'recalled');
    assert.deepEqual(d.store[`${KEY}.widgets`], [{ id: 'agenda' }]);
    assert.ok(!(`${KEY}.islands` in d.store), 'the row the preset does not hold is forgotten');
    assert.ok(`${KEY}.presets` in d.store, 'the preset row survives its own recall');
    assert.ok(`${KEY}.nav` in d.store, 'the rail\'s leftover is no arrangement: left alone');
    assert.deepEqual(d.calls, [
      { method: 'DELETE', scope: `${KEY}.islands` },
      { method: 'PUT', scope: `${KEY}.widgets` },
    ]);
  } finally { d.restore(); }
});

test('a recall announces itself even when a write failed, so nothing looks untouched', async () => {
  const preset: LayoutPreset = { id: 'p1', name: 'Review', createdAt: 1, scopes: { widgets: [1] } };
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof globalThis.fetch;
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('', { url: 'http://localhost/' });
  const saved = new Map(['window', 'CustomEvent']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  (globalThis as Record<string, unknown>).window = dom.window;
  // jsdom refuses an event built by Node's own constructor: the two realms do
  // not share `Event`. A browser has only one.
  (globalThis as Record<string, unknown>).CustomEvent = dom.window.CustomEvent;
  let announced = 0;
  dom.window.addEventListener(LAYOUT_RECALLED_EVENT, () => { announced += 1; });
  try {
    assert.equal(await recallView(KEY, preset, {}), 'failed');
    assert.equal(announced, 1);
  } finally {
    globalThis.fetch = original;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    dom.window.close();
  }
});

/**
 * Writing the presets row — the only path the menu has to the daemon.
 *
 * Both tests exist because the menu used to fire and forget: it closed its
 * form and announced a success the moment the mutation was computed, with the
 * request still in the air. The two failures that produced a lie on screen —
 * a row the daemon would refuse for its size, and a write it simply did not
 * take — are pinned here, where they can be tested without mounting a
 * dropdown (`npm test` in `app/` runs `src/lib/*.test.ts`).
 */

/** A presets list serialising to `bytes` exactly. */
function heavy(bytes: number): LayoutPreset[] {
  const base: LayoutPreset = { id: 'a', name: 'Heavy', createdAt: 0, scopes: { widgets: '' } };
  const overhead = presetsBytes([base]);
  return [{ ...base, scopes: { widgets: 'x'.repeat(bytes - overhead) } }];
}

test('a row over the cap is refused before anything reaches the daemon', async () => {
  const d = daemon({});
  try {
    const out = await commitPresets(
      [],
      () => heavy(MAX_PRESETS_BYTES + 1),
      (op) => saveLayout(op(null), { scope: `${KEY}.presets`, storage: null }),
    );
    assert.deepEqual(out, { ok: false, error: 'too-large' });
    // The point of the test: the 400 never had to happen, because the PUT
    // never left. A cap checked only by the daemon would answer after the
    // menu had already closed its form.
    assert.deepEqual(d.calls, []);
    assert.ok(!(`${KEY}.presets` in d.store));
  } finally { d.restore(); }
});

test('a row at the cap is written, so the guard refuses nothing the daemon takes', async () => {
  const d = daemon({});
  try {
    const presets = heavy(MAX_PRESETS_BYTES);
    const out = await commitPresets(
      [],
      () => presets,
      (op) => saveLayout(op(null), { scope: `${KEY}.presets`, storage: null }),
    );
    assert.deepEqual(out, { ok: true });
    assert.deepEqual(d.calls, [{ method: 'PUT', scope: `${KEY}.presets` }]);
    assert.deepEqual(d.store[`${KEY}.presets`], { v: 1, presets });
  } finally { d.restore(); }
});

test('a daemon that refuses the write is never reported as a success', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof globalThis.fetch;
  try {
    const out = await commitPresets(
      [],
      () => [{ id: 'a', name: 'Review', createdAt: 0, scopes: { widgets: [1] } }],
      (op) => saveLayout(op(null), { scope: `${KEY}.presets`, storage: null }),
    );
    // `write-failed` and not a silent `ok`: the menu keys its form, its toast
    // and its rollback off this verdict.
    assert.deepEqual(out, { ok: false, error: 'write-failed' });
  } finally { globalThis.fetch = original; }
});

// TODO #647: what reaches the daemon is the change applied to the row as it
// stands, so a replay over another window's preset keeps that preset.
test('the change is applied to the stored list, not to the list it was measured on', async () => {
  const theirs: LayoutPreset = { id: 'theirs', name: 'Theirs', createdAt: 0, scopes: {} };
  const mine: LayoutPreset = { id: 'mine', name: 'Mine', createdAt: 1, scopes: {} };
  let written: unknown;
  const out = await commitPresets(
    [],
    (list) => [...list, mine],
    async (op) => { written = op({ v: 1, presets: [theirs] }); return true; },
  );
  assert.deepEqual(out, { ok: true });
  assert.deepEqual(written, { v: 1, presets: [theirs, mine] });
});

/**
 * The per-project row, dropped once folded into the shared one.
 *
 * Without this the fold is not a migration but a resurrection: it only runs on
 * an empty shared list, so a user who deletes every migrated preset empties it
 * again and gets them all back on the next reload.
 */
test('a folded legacy row leaves the daemon', async () => {
  const d = daemon({ [`${KEY}.presets`]: { v: 1, presets: [{ id: 'p1' }] } });
  try {
    assert.equal(await forgetPresets(`${KEY}.presets`), true);
    assert.deepEqual(d.calls, [{ method: 'DELETE', scope: `${KEY}.presets` }]);
    assert.ok(!(`${KEY}.presets` in d.store));
  } finally { d.restore(); }
});

test('the keys of a pathname cover every project and the project-less view, once each', async () => {
  const keys = await viewKeysOfAllProjects('u1', '/chat', ['alpha', 'beta', 'alpha']);
  assert.deepEqual(keys, await Promise.all([null, 'alpha', 'beta'].map((p) => workspaceScope('u1', '/chat', p))));
  assert.ok(!keys.includes(await workspaceScope('u1', '/other', 'alpha')), 'never another pathname');
  assert.ok(!keys.includes(await workspaceScope('u2', '/chat', 'alpha')), 'never another account');
});

test('applying a preset everywhere rewrites each view and forgets what it does not hold', async () => {
  const preset: LayoutPreset = { id: 'p1', name: 'Review', createdAt: 1, scopes: { widgets: [{ id: 'agenda' }] } };
  const [a, b] = ['v2.aaa', 'v2.bbb'];
  const d = daemon({
    [`${a}.widgets`]: [1], [`${a}.islands`]: { v: 1 },
    [`${b}.columns`]: { left: 1 },
  });
  try {
    assert.deepEqual(await recallEverywhere([a, b], preset), { applied: 2, failed: 0 });
    assert.deepEqual(d.store[`${a}.widgets`], [{ id: 'agenda' }]);
    assert.deepEqual(d.store[`${b}.widgets`], [{ id: 'agenda' }]);
    assert.ok(!(`${a}.islands` in d.store) && !(`${b}.columns` in d.store));
  } finally { d.restore(); }
});

test('a view that cannot be read is reported and does not stop the others', async () => {
  const preset: LayoutPreset = { id: 'p1', name: 'Review', createdAt: 1, scopes: { widgets: [2] } };
  const d = daemon({}, { readable: false });
  try {
    assert.deepEqual(await recallEverywhere(['v2.aaa', 'v2.bbb'], preset), { applied: 0, failed: 2 });
    assert.deepEqual(d.calls, [], 'nothing is written over a view that was not read');
  } finally { d.restore(); }
});

test('the project list is null when the daemon refuses, never an empty list', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ projects: [{ slug: 'a' }, { slug: '' }, { name: 'x' }] })) as typeof globalThis.fetch;
    assert.deepEqual(await listProjectSlugs(), ['a']);
    globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof globalThis.fetch;
    assert.equal(await listProjectSlugs(), null);
    globalThis.fetch = (async () => { throw new Error('down'); }) as typeof globalThis.fetch;
    assert.equal(await listProjectSlugs(), null);
  } finally { globalThis.fetch = original; }
});

test('a preset that replaces the islands asks the workspace on screen first, and closes after the write', async () => {
  const preset: LayoutPreset = { id: 'p1', name: 'Review', createdAt: 1, scopes: { widgets: [{ id: 'agenda' }] } };
  const d = daemon({ [`${KEY}.islands`]: { v: 1 }, [`${KEY}.widgets`]: [] });
  const steps: string[] = [];
  let agree = false;
  const withdraw = announceIslandWorkspace({
    open: () => false, activate: () => {}, close: () => {},
    owns: (key) => key === KEY,
    release: async (key) => {
      steps.push(`ask ${key}`);
      return agree ? () => { steps.push(`close after ${d.calls.length} write(s)`); } : null;
    },
  });
  try {
    const current = (await captureView(KEY))!;
    const before = d.calls.length;
    assert.equal(await recallView(KEY, preset, current), 'cancelled');
    assert.equal(d.calls.length, before, 'nothing written');
    agree = true;
    assert.equal(await recallView(KEY, preset, current), 'recalled');
    assert.deepEqual(steps, [`ask ${KEY}`, `ask ${KEY}`, `close after ${before + 2} write(s)`]);
  } finally {
    withdraw();
    d.restore();
  }
});

test('applying everywhere ends the shells it replaces off screen, after each row, never one the screen shows', async () => {
  const slots = await import('./plugin-host/slots');
  const { defaultIslandTree, insertAt } = await import('./island-tree');
  const { publishIslandTabs } = await import('./island-bus');
  slots.resetSlotsForTests();
  slots.declareSlot('island.content', 'list');
  const d = daemon({});
  const ended: string[] = [];
  slots.register({
    slot: 'island.content', pluginId: '@rooks/terminal-web', key: 'session',
    island: {
      title: 'Terminal', parseParams: (raw) => raw as Record<string, string>, singletonBy: 'sessionId',
      onClose: (params) => { ended.push(`${String(params.sessionId)} after ${d.calls.length} write(s)`); },
    },
  }, () => null);
  const { allLeaves } = await import('./island-tree');
  const shell = (sessionId: string) => ({ type: '@rooks/terminal-web:session', params: { scope: null, sessionId } });
  const treeWith = (...sessions: string[]) => {
    let tree = defaultIslandTree();
    for (const id of sessions) tree = insertAt(tree, tree.focus!, 'right', shell(id)).tree;
    return tree;
  };
  d.store['v2.aaa.islands'] = treeWith('s1', 's2');
  d.store['v2.bbb.islands'] = treeWith('s3');
  // On screen: another view, showing s1 too.
  const handle = { open: () => false, activate: () => {}, close: () => {}, owns: (key: string) => key === KEY, release: async () => () => {} };
  const withdraw = announceIslandWorkspace(handle);
  publishIslandTabs(handle, allLeaves(treeWith('s1')).flatMap((leaf) => leaf.tabs), false);
  try {
    const preset: LayoutPreset = { id: 'p1', name: 'Bare', createdAt: 1, scopes: { widgets: [] } };
    assert.deepEqual(await recallEverywhere(['v2.aaa', 'v2.bbb'], preset), { applied: 2, failed: 0 });
    assert.ok(!('v2.aaa.islands' in d.store) && !('v2.bbb.islands' in d.store));
    // aaa: widgets PUT + islands DELETE, then its shells; bbb likewise.
    assert.deepEqual(ended, ['s2 after 2 write(s)', 's3 after 4 write(s)'], 's1 stays: the screen still shows it');
  } finally {
    withdraw();
    slots.resetSlotsForTests();
    d.restore();
  }
});
