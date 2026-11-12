/**
 * Named island arrangements: the list, its store against a fake daemon, and
 * laying one on a view.
 *
 * What breaks silently: a window left on an old copy of the list erasing the
 * arrangement another one just saved, an arrangement that keeps yesterday's
 * conversation, and a page address that changes when the arrangement is
 * overwritten.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ARRANGEMENTS,
  addArrangement,
  arrangementHref,
  arrangementIdOf,
  readArrangements,
  removeArrangement,
  renameArrangement,
  replaceArrangement,
  setArrangementMenu,
  writeArrangements,
  type IslandArrangement,
} from './island-arrangements';
import {
  arrangementsState,
  followArrangementsOwner,
  mutateArrangements,
  refreshArrangements,
} from './island-arrangements-store';
import { captureArrangement, islandsScope, recallArrangement } from './island-arrangements-io';
import { HOST_ROUTE, allLeaves, defaultIslandTree, readIslandTree, type IslandParams, type IslandTree } from './island-tree';
import type { PresetContentType } from './island-presets';
import { sharedArrangementsScope } from './workspace-scope';
import { announceIslandWorkspace } from './island-bus';

const CHAT = '@rooks/missions:chat';
const chat: PresetContentType = {
  volatileParams: ['missionId', 'fresh'],
  parseParams: (raw): IslandParams | null => {
    const { agent, missionId } = raw as Record<string, unknown>;
    return typeof agent === 'string' ? { agent, missionId: typeof missionId === 'string' ? missionId : null, fresh: false } : null;
  },
};
const types = new Map([[CHAT, chat]]);

function split(missionId: string | null = null): IslandTree {
  return readIslandTree({
    v: 1, focus: 'a',
    root: { id: 's', kind: 'split', dir: 'row', ratios: [0.6, 0.4], children: [
      { id: 'a', kind: 'leaf', active: 'r', tabs: [{ id: 'r', content: { type: HOST_ROUTE, params: {} } }] },
      { id: 'b', kind: 'leaf', active: 'c', tabs: [{ id: 'c', content: { type: CHAT, params: { agent: 'acme.coder', ...(missionId ? { missionId } : {}) } } }] },
    ] },
  });
}

const ok = <T,>(r: { ok: true } & T | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`refused: ${r.error}`);
  return r;
};

// ---------------------------------------------------------------- the list

test('add: a name, a tree that is more than the page, twelve at most', () => {
  assert.deepEqual(addArrangement([], '  ', split()), { ok: false, error: 'empty-name' });
  assert.deepEqual(addArrangement([], 'Solo', defaultIslandTree()), { ok: false, error: 'empty-tree' });
  const first = ok(addArrangement([], ' Morning  review ', split(), 5));
  assert.equal(first.arrangement.name, 'Morning review');
  assert.equal(first.arrangement.menu, false);
  assert.match(first.arrangement.id, /^[A-Za-z0-9-]+$/);
  assert.deepEqual(addArrangement(first.arrangements, 'MORNING REVIEW', split()), { ok: false, error: 'duplicate-name' });
  const full = Array.from({ length: MAX_ARRANGEMENTS }, (_, i): IslandArrangement => ({ id: `a${i}`, name: `n${i}`, createdAt: 0, tree: split(), menu: false }));
  assert.deepEqual(addArrangement(full, 'one more', split()), { ok: false, error: 'too-many' });
});

test('rename, overwrite, menu, delete keep the id: the page keeps its address', () => {
  const { arrangements, arrangement } = ok(addArrangement([], 'Board', split(), 1));
  const renamed = ok(renameArrangement(arrangements, arrangement.id, 'board'));
  assert.equal(renamed.arrangement.name, 'board', 'fixing the case of its own name');
  const replaced = ok(replaceArrangement(renamed.arrangements, arrangement.id, split('m-2')));
  assert.equal(replaced.arrangement.id, arrangement.id);
  assert.equal(replaced.arrangement.createdAt, 1);
  assert.deepEqual(replaceArrangement(renamed.arrangements, arrangement.id, defaultIslandTree()), { ok: false, error: 'empty-tree' });
  const pinned = ok(setArrangementMenu(replaced.arrangements, arrangement.id, true));
  assert.equal(pinned.arrangement.menu, true);
  assert.deepEqual(setArrangementMenu(pinned.arrangements, 'nope', true), { ok: false, error: 'unknown' });
  assert.deepEqual(ok(removeArrangement(pinned.arrangements, arrangement.id)).arrangements, []);
  assert.deepEqual(removeArrangement([], arrangement.id), { ok: false, error: 'unknown' });
});

test('read: a bad entry is dropped alone, an id that would need encoding in a URL too', () => {
  const good = { id: 'a-1', name: 'Good', createdAt: 3, tree: split(), menu: true };
  const out = readArrangements({ v: 1, arrangements: [
    good,
    { id: 'a/b', name: 'Slash', tree: split() },
    { id: 'x', name: '', tree: split() },
    { id: 'y', name: 'No tree' },
    { ...good, name: 'Twin' },
    'junk',
  ] });
  assert.deepEqual(out.map((a) => a.name), ['Good']);
  assert.equal(out[0]!.menu, true);
  assert.deepEqual(readArrangements(null), []);
  assert.deepEqual(readArrangements(writeArrangements(out)), out);
});

test('the page address of an arrangement, both ways', () => {
  assert.equal(arrangementHref('a-1'), '/islands/a-1');
  assert.equal(arrangementIdOf('/islands/a-1'), 'a-1');
  assert.equal(arrangementIdOf('/islands/a-1/'), 'a-1');
  assert.equal(arrangementIdOf('/islands'), null);
  assert.equal(arrangementIdOf('/islands/a%2Fb'), null);
  assert.equal(arrangementIdOf('/chat'), null);
  assert.equal(arrangementIdOf(null), null);
});

// ---------------------------------------------------------------- against a daemon

type Row = { layout: unknown; updatedAt: number };

/** A daemon of single rows with the version guard of `PUT /api/layout?expected=`. */
function daemon(initial: Record<string, unknown> = {}) {
  const rows = new Map<string, Row>(Object.entries(initial).map(([scope, layout]) => [scope, { layout, updatedAt: 1 }]));
  const writes: string[] = [];
  let clock = 10;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const scope = url.searchParams.get('scope')!;
    const expected = url.searchParams.get('expected');
    const method = init?.method ?? 'GET';
    const row = rows.get(scope);
    if (method === 'GET') return Response.json({ scope, layout: row?.layout ?? null, updatedAt: row?.updatedAt ?? null });
    if (expected !== null && expected !== (row ? String(row.updatedAt) : 'none')) {
      return Response.json({ error: 'conflict', updatedAt: row?.updatedAt ?? null }, { status: 409 });
    }
    writes.push(`${method} ${scope}`);
    if (method === 'DELETE') { rows.delete(scope); return Response.json({ ok: true, updatedAt: null }); }
    const updatedAt = ++clock;
    rows.set(scope, { layout: (JSON.parse(String(init!.body)) as { layout: unknown }).layout, updatedAt });
    return Response.json({ ok: true, updatedAt });
  }) as typeof globalThis.fetch;
  return { rows, writes, restore() { globalThis.fetch = original; } };
}

test('the store reads the account\'s list, and empties it at once for another account', async () => {
  const scope = await sharedArrangementsScope('u1');
  const d = daemon({ [scope]: writeArrangements([{ id: 'a', name: 'Kept', createdAt: 0, tree: split(), menu: true }]) });
  try {
    followArrangementsOwner('u1');
    assert.equal(await refreshArrangements(), true);
    assert.deepEqual(arrangementsState().arrangements.map((a) => a.name), ['Kept']);
    followArrangementsOwner('u2');
    assert.deepEqual(arrangementsState(), { owner: 'u2', ready: false, arrangements: [] });
    await refreshArrangements();
    assert.deepEqual(arrangementsState().arrangements, []);
  } finally { d.restore(); followArrangementsOwner(null); }
});

test('a change applies to the list the daemon holds now, never to a stale copy', async () => {
  const scope = await sharedArrangementsScope('u3');
  const d = daemon();
  try {
    followArrangementsOwner('u3');
    await refreshArrangements();
    // Another window saves one after this one painted its (empty) list.
    d.rows.set(scope, { layout: writeArrangements([{ id: 'other', name: 'From elsewhere', createdAt: 0, tree: split(), menu: false }]), updatedAt: 5 });
    const out = await mutateArrangements((list) => addArrangement(list, 'Mine', split()));
    assert.equal(out.ok, true);
    const stored = readArrangements(d.rows.get(scope)!.layout);
    assert.deepEqual(stored.map((a) => a.name), ['From elsewhere', 'Mine']);
    assert.deepEqual(arrangementsState().arrangements.map((a) => a.name), ['From elsewhere', 'Mine']);
    // A refusal of the operation is reported, and nothing is written.
    const before = d.writes.length;
    assert.deepEqual(await mutateArrangements((list) => addArrangement(list, 'mine', split())), { ok: false, error: 'duplicate-name' });
    assert.equal(d.writes.length, before);
  } finally { d.restore(); followArrangementsOwner(null); }
});

test('without an account nothing is written', async () => {
  followArrangementsOwner(null);
  assert.deepEqual(await mutateArrangements((list) => addArrangement(list, 'x', split())), { ok: false, error: 'write-failed' });
});

test('capture keeps the agents, not the conversations; a view showing its page alone is refused', async () => {
  const KEY = 'v2.cafe';
  const d = daemon({ [islandsScope(KEY)]: split('m-1') });
  try {
    const tree = await captureArrangement(KEY, types);
    assert.ok(tree && tree !== 'empty');
    const chatTab = allLeaves(tree).flatMap((l) => l.tabs).find((t) => t.content.type === CHAT)!;
    assert.deepEqual(chatTab.content.params, { agent: 'acme.coder' });
    assert.equal(await captureArrangement('v2.empty', types), 'empty');
  } finally { d.restore(); }
});

test('recall writes the islands row only, and tells the mounted workspace', async () => {
  const KEY = 'v2.beef';
  const d = daemon({ [`${KEY}.widgets`]: [{ id: 'agenda' }] });
  const heard: string[] = [];
  const target = new EventTarget();
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = target;
  target.addEventListener('rooks:layout-recalled', () => heard.push('recalled'));
  try {
    const arrangement: IslandArrangement = { id: 'a', name: 'A', createdAt: 0, tree: split('m-9'), menu: false };
    assert.equal(await recallArrangement(KEY, arrangement, types), 'recalled');
    assert.deepEqual(d.writes, [`PUT ${islandsScope(KEY)}`]);
    const laid = readIslandTree(d.rows.get(islandsScope(KEY))!.layout);
    assert.equal(allLeaves(laid).flatMap((l) => l.tabs).some((t) => 'missionId' in t.content.params), false);
    assert.deepEqual(heard, ['recalled']);
  } finally {
    d.restore();
    (globalThis as { window?: unknown }).window = previous;
  }
});

test('recall asks the workspace on screen first: a refusal writes nothing, an agreement closes after the write', async () => {
  const KEY = 'v2.f00d';
  const d = daemon({});
  const steps: string[] = [];
  let agree = false;
  const withdraw = announceIslandWorkspace({
    open: () => false, activate: () => {}, close: () => {},
    owns: (key) => key === KEY,
    release: async (key) => {
      steps.push(`ask ${key}`);
      return agree ? () => { steps.push(`close after ${d.writes.length} write(s)`); } : null;
    },
  });
  try {
    const arrangement: IslandArrangement = { id: 'a', name: 'A', createdAt: 0, tree: split('m-1'), menu: false };
    assert.equal(await recallArrangement(KEY, arrangement, types), 'cancelled');
    assert.deepEqual(d.writes, [], 'a tab that asked to stay keeps the view as it was');
    agree = true;
    assert.equal(await recallArrangement(KEY, arrangement, types), 'recalled');
    assert.deepEqual(steps, [`ask ${KEY}`, `ask ${KEY}`, 'close after 1 write(s)']);
  } finally {
    withdraw();
    d.restore();
  }
});
