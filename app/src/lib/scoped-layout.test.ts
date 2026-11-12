import assert from 'node:assert/strict';
import test from 'node:test';
import type { useStoredLayout } from '../hooks/use-stored-layout';
import type { LayoutHandoverInput } from './layout-handover';

type LayoutState = ReturnType<typeof useStoredLayout>;
type MockFetch = typeof globalThis.fetch;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function harness(fetchImpl: MockFetch) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const globals = globalThis as Record<string, unknown>;
  const previous = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { useStoredLayout } = await import('../hooks/use-stored-layout');
  const { LayoutSeedsProvider } = await import('../components/layout-seeds');
  const root = createRoot(document.getElementById('root')!);
  let current!: LayoutState;
  function Reader({ scope, legacy }: { scope: string | null; legacy?: LayoutHandoverInput }) {
    current = useStoredLayout(scope, legacy, { cancelQueuedOnUnmount: scope === 'appearance.background' });
    return null;
  }
  return {
    get state() { return current; },
    async render(scope: string | null, legacy?: LayoutHandoverInput, seeds: Record<string, unknown> = {}) {
      await React.act(async () => {
        root.render(React.createElement(
          LayoutSeedsProvider,
          { seeds },
          React.createElement(Reader, { scope, legacy }),
        ));
      });
    },
    async act(fn: () => void | Promise<void>) { await React.act(fn); },
    async close() {
      await React.act(async () => { root.unmount(); });
      globalThis.fetch = originalFetch;
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globals[key];
      }
      dom.window.close();
    },
  };
}

test('navigation ignores a late project read and rejects updates captured in the old scope', async () => {
  const pending = deferred<Response>();
  const writes: string[] = [];
  const h = await harness(async (input, init) => {
    const scope = new URL(String(input), 'http://localhost').searchParams.get('scope')!;
    if (init?.method === 'PUT') { writes.push(scope); return Response.json({ ok: true }); }
    return scope === 'pending-project' ? pending.promise : Response.json({ layout: { marker: scope } });
  });
  try {
    await h.render('pending-project');
    const staleUpdate = h.state.update;
    assert.equal(h.state.ready, false);
    await h.render('current-project');
    assert.equal(h.state.ready, true);
    await h.act(async () => { pending.resolve(Response.json({ layout: { marker: 'obsolete' } })); });
    await h.act(() => { staleUpdate(() => ({ marker: 'stale edit' })); });
    assert.deepEqual(h.state.raw, { marker: 'current-project' });
    assert.deepEqual(writes, []);
  } finally { await h.close(); }
});

test('a failed layout read blocks both edits and writes instead of overwriting saved state', async () => {
  let writes = 0;
  const h = await harness(async (_input, init) => {
    if (init?.method === 'PUT') { writes++; return Response.json({ ok: true }); }
    return new Response(null, { status: 503 });
  });
  try {
    await h.render('unavailable-project');
    assert.equal(h.state.ready, false);
    await h.act(() => { h.state.update(() => ({ open: true })); });
    assert.equal(h.state.raw, null);
    assert.equal(writes, 0);
  } finally { await h.close(); }
});

test('project scopes persist independently and successive updates compose from the latest value', async () => {
  const stored = new Map<string, unknown>([
    ['project-a', { open: false, width: 400 }],
    ['project-b', { open: false, width: 600 }],
  ]);
  const writes: string[] = [];
  const h = await harness(async (input, init) => {
    const scope = new URL(String(input), 'http://localhost').searchParams.get('scope')!;
    if (init?.method === 'PUT') {
      stored.set(scope, JSON.parse(String(init.body)).layout);
      writes.push(scope);
      return Response.json({ ok: true });
    }
    return Response.json({ layout: stored.get(scope) ?? null });
  });
  try {
    await h.render('project-a');
    await h.act(() => {
      h.state.update((raw) => ({ ...(raw as object), open: true }));
      h.state.update((raw) => ({ ...(raw as object), width: 480 }));
    });
    await h.render('project-b');
    assert.deepEqual(h.state.raw, { open: false, width: 600 });
    await h.act(() => { h.state.update((raw) => ({ ...(raw as object), width: 720 })); });
    await h.render('project-a');
    assert.deepEqual(h.state.raw, { open: true, width: 480 });
    await h.render('project-b');
    assert.deepEqual(h.state.raw, { open: false, width: 720 });
    assert.deepEqual(new Set(writes), new Set(['project-a', 'project-b']));
  } finally { await h.close(); }
});

test('writing null erases the scope with a DELETE, never a PUT the daemon refuses', async () => {
  const stored = new Map<string, unknown>([['view.islands', { split: true }]]);
  const writes: string[] = [];
  let refuseDelete = false;
  const h = await harness(async (input, init) => {
    const scope = new URL(String(input), 'http://localhost').searchParams.get('scope')!;
    if (init?.method === 'PUT') {
      const layout = JSON.parse(String(init.body)).layout;
      writes.push(`PUT ${JSON.stringify(layout)}`);
      if (layout === null) return Response.json({ error: 'layout is required' }, { status: 400 });
      stored.set(scope, layout);
      return Response.json({ ok: true });
    }
    if (init?.method === 'DELETE') {
      writes.push('DELETE');
      if (refuseDelete) return new Response(null, { status: 503 });
      stored.delete(scope);
      return Response.json({ ok: true });
    }
    return Response.json({ layout: stored.get(scope) ?? null });
  });
  try {
    await h.render('view.islands');
    let ok: boolean | undefined;
    await h.act(async () => { ok = await h.state.update(() => null); });
    assert.equal(ok, true);
    assert.deepEqual(writes, ['DELETE']);
    assert.equal(h.state.raw, null);
    assert.equal(stored.has('view.islands'), false);
    // Anything else is still a save.
    await h.act(async () => { ok = await h.state.update(() => ({ split: false })); });
    assert.deepEqual(writes, ['DELETE', 'PUT {"split":false}']);
    // A refused erasure is reported like a refused save.
    refuseDelete = true;
    await h.act(async () => { ok = await h.state.update(() => null); });
    assert.equal(ok, false);
    assert.deepEqual(stored.get('view.islands'), { split: false });
  } finally { await h.close(); }
});

test('a cancelled initial read must not initiate legacy migration', async () => {
  const pending = deferred<Response>();
  const requests: string[] = [];
  const h = await harness(async (input, init) => {
    const scope = new URL(String(input), 'http://localhost').searchParams.get('scope')!;
    requests.push(`${init?.method ?? 'GET'} ${scope}`);
    if (scope === 'cancelled-migration' && init?.method !== 'PUT') return pending.promise;
    return Response.json({ layout: { marker: 'legacy' } });
  });
  try {
    await h.render('cancelled-migration', 'legacy-before-navigation');
    await h.render(null);
    await h.act(async () => { pending.resolve(Response.json({ layout: null })); });
    assert.deepEqual(requests, ['GET cancelled-migration']);
    assert.equal(h.state.ready, false);
  } finally { await h.close(); }
});

test('a cancelled legacy read must not save under the abandoned project scope', async () => {
  const pending = deferred<Response>();
  const writes: string[] = [];
  const h = await harness(async (input, init) => {
    const scope = new URL(String(input), 'http://localhost').searchParams.get('scope')!;
    if (init?.method === 'PUT') { writes.push(scope); return Response.json({ ok: true }); }
    return scope === 'legacy-read-in-flight' ? pending.promise : Response.json({ layout: null });
  });
  try {
    await h.render('abandoned-project', 'legacy-read-in-flight');
    await h.render(null);
    await h.act(async () => { pending.resolve(Response.json({ layout: { marker: 'legacy' } })); });
    assert.deepEqual(writes, []);
  } finally { await h.close(); }
});

/** One row as the daemon holds it: versioned, refusing a write made on an old read (`?expected=`). */
function versionedRow(initial: unknown) {
  const row = { layout: initial, version: 1, writes: [] as string[] };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const expected = new URL(String(input), 'http://localhost').searchParams.get('expected');
    const method = init?.method ?? 'GET';
    if (method === 'GET') return Response.json({ layout: row.layout, updatedAt: row.version });
    row.writes.push(`${method} expected=${expected}`);
    if (expected !== null && Number(expected) !== row.version) return Response.json({ error: 'conflict' }, { status: 409 });
    row.layout = method === 'DELETE' ? null : JSON.parse(String(init?.body)).layout;
    row.version += 1;
    return Response.json({ ok: true, updatedAt: row.version });
  }) as MockFetch;
  /** What another window (the desktop app, a second tab) writes meanwhile. */
  const elsewhere = (layout: unknown) => { row.layout = layout; row.version += 1; };
  return { row, fetchImpl, elsewhere };
}

/**
 * TODO #375: two windows on the same view. This one read the row, another one
 * then added an island (an agent's proposal applied there); this window's
 * next gesture used to rewrite the whole row from its old copy, erasing it.
 * TODO #647: the refused gesture is then replayed on the row read again,
 * instead of being lost.
 */
test('a gesture made on a copy another window rewrote is replayed on top of what that window added', async () => {
  const daemon = versionedRow({ islands: ['chat'] });
  const h = await harness(daemon.fetchImpl);
  try {
    await h.render('project.islands');
    daemon.elsewhere({ islands: ['chat', 'files'] });
    let ok: boolean | undefined;
    await h.act(async () => {
      ok = await h.state.update((raw) => ({ ...(raw as object), focused: 'chat' }));
    });
    assert.equal(ok, true, 'the gesture lands after its replay');
    assert.deepEqual(daemon.row.layout, { islands: ['chat', 'files'], focused: 'chat' }, 'both windows\' changes are kept');
    assert.deepEqual(h.state.raw, { islands: ['chat', 'files'], focused: 'chat' }, 'this window shows them both');
    assert.deepEqual(daemon.row.writes, ['PUT expected=1', 'PUT expected=2'], 'refused once, then written on the version read again');
    await h.act(async () => { ok = await h.state.update((raw) => ({ ...(raw as object), focused: 'files' })); });
    assert.equal(ok, true);
    assert.deepEqual(daemon.row.layout, { islands: ['chat', 'files'], focused: 'files' });
  } finally { await h.close(); }
});

test('the gestures queued behind a refused write, and those made during its replay, land in one replay', async () => {
  const daemon = versionedRow({ tabs: [] as string[] });
  let reads = 0;
  const counting = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') reads++;
    return daemon.fetchImpl(input, init);
  }) as MockFetch;
  const h = await harness(counting);
  try {
    await h.render('project.tabs');
    reads = 0;
    daemon.elsewhere({ tabs: ['theirs'] });
    const add = (tab: string) => h.state.update((raw) => ({ tabs: [...((raw as { tabs: string[] }).tabs), tab] }));
    let results: boolean[] = [];
    await h.act(async () => {
      const first = [add('a'), add('b'), add('c')];
      // A gesture made while the row is read again waits for the replay.
      await new Promise((done) => setTimeout(done, 0));
      results = await Promise.all([...first, add('d')]);
    });
    assert.deepEqual(results, [true, true, true, true]);
    assert.deepEqual(daemon.row.layout, { tabs: ['theirs', 'a', 'b', 'c', 'd'] }, 'nothing lost, nothing applied twice');
    assert.deepEqual(h.state.raw, daemon.row.layout);
    assert.equal(reads, 1, 'a single re-read answers for every stale write');
  } finally { await h.close(); }
});

test('a gesture still being dragged when the row is refused is replayed with the rest', async () => {
  const daemon = versionedRow({ width: 300, side: 'left' });
  const h = await harness(daemon.fetchImpl);
  try {
    await h.render('project.columns');
    daemon.elsewhere({ width: 300, side: 'right' });
    let ok: boolean | undefined;
    await h.act(async () => {
      void h.state.update((raw) => ({ ...(raw as object), width: 320 }), false);
      ok = await h.state.update((raw) => ({ ...(raw as object), width: 340 }));
    });
    assert.equal(ok, true);
    assert.deepEqual(daemon.row.layout, { width: 340, side: 'right' });
  } finally { await h.close(); }
});

test('a row rewritten at every attempt is not chased forever: the gesture gives way to it', async () => {
  const row = { layout: { n: 0 } as unknown, version: 1 };
  let puts = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') {
      // Another window writes again between every read and the next write.
      const answer = Response.json({ layout: row.layout, updatedAt: row.version });
      row.layout = { n: row.version }; row.version += 1;
      return answer;
    }
    puts++;
    return Response.json({ error: 'conflict' }, { status: 409 });
  }) as MockFetch;
  const h = await harness(fetchImpl);
  try {
    await h.render('project.islands');
    let ok: boolean | undefined;
    await h.act(async () => {
      ok = await h.state.update((raw) => ({ ...(raw as object), mine: true }));
      await new Promise((done) => setTimeout(done, 0));
    });
    assert.equal(ok, false);
    assert.ok(puts <= 4, `bounded attempts (${puts})`);
    assert.equal((h.state.raw as { mine?: boolean }).mine, undefined, 'the screen shows the stored row, not the lost gesture');
  } finally { await h.close(); }
});

test('a failed write asked to undo itself leaves the screen, and the next write does not carry it', async () => {
  const daemon = versionedRow({ presets: ['a'] });
  let fail = true;
  const h = await harness((async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT' && fail) { fail = false; return Response.json({ error: 'too large' }, { status: 400 }); }
    return daemon.fetchImpl(input, init);
  }) as MockFetch);
  try {
    await h.render('project.presets');
    const add = (name: string) => h.state.update((raw) => ({ presets: [...(raw as { presets: string[] }).presets, name] }), true, { undoOnFailure: true });
    let ok: boolean | undefined;
    await h.act(async () => { ok = await add('refused'); });
    assert.equal(ok, false);
    assert.deepEqual(h.state.raw, { presets: ['a'] }, 'rolled back on screen');
    await h.act(async () => { ok = await add('b'); });
    assert.equal(ok, true);
    assert.deepEqual(daemon.row.layout, { presets: ['a', 'b'] });
  } finally { await h.close(); }
});

test('coming back to the window keeps a gesture not written yet over the newer row', async () => {
  const daemon = versionedRow({ width: 300, side: 'left' });
  const h = await harness(daemon.fetchImpl);
  try {
    await h.render('project.columns');
    await h.act(async () => { void h.state.update((raw) => ({ ...(raw as object), width: 360 }), false); });
    daemon.elsewhere({ width: 300, side: 'right' });
    await h.act(async () => {
      window.dispatchEvent(new window.Event('focus'));
      await new Promise((done) => setTimeout(done, 0));
    });
    assert.deepEqual(h.state.raw, { width: 360, side: 'right' });
    let ok: boolean | undefined;
    await h.act(async () => { ok = await h.state.update((raw) => raw); });
    assert.equal(ok, true);
    assert.deepEqual(daemon.row.layout, { width: 360, side: 'right' });
  } finally { await h.close(); }
});

test('the successive drops of one drag chain on their own versions', async () => {
  const daemon = versionedRow({ width: 300 });
  const h = await harness(daemon.fetchImpl);
  try {
    await h.render('project.columns');
    let results: boolean[] = [];
    await h.act(async () => {
      results = await Promise.all([320, 340, 360].map((width) => h.state.update((raw) => ({ ...(raw as object), width }))));
    });
    assert.deepEqual(results, [true, true, true]);
    assert.deepEqual(daemon.row.layout, { width: 360 });
    assert.ok(daemon.row.writes.every((w) => w !== 'PUT expected=null'), 'every drop is guarded');
  } finally { await h.close(); }
});

test('coming back to the window re-reads a row another window rewrote', async () => {
  const daemon = versionedRow({ islands: ['chat'] });
  const h = await harness(daemon.fetchImpl);
  try {
    await h.render('project.islands');
    daemon.elsewhere({ islands: ['chat', 'browser'] });
    await h.act(async () => {
      window.dispatchEvent(new window.Event('focus'));
      await new Promise((done) => setTimeout(done, 0));
    });
    assert.deepEqual(h.state.raw, { islands: ['chat', 'browser'] });
    let ok: boolean | undefined;
    await h.act(async () => { ok = await h.state.update((raw) => ({ ...(raw as object), focused: 'browser' })); });
    assert.equal(ok, true, 'the gesture after the re-read lands');
    assert.deepEqual(daemon.row.layout, { islands: ['chat', 'browser'], focused: 'browser' });
  } finally { await h.close(); }
});

test('an upload finishing after its owner unmounts cannot write preferences', async () => {
  let writes = 0;
  const h = await harness(async (_input, init) => {
    if (init?.method === 'PUT') writes++;
    return Response.json({ layout: {} });
  });
  await h.render('appearance.background');
  const staleUpdate = h.state.update;
  await h.close();
  assert.equal(await staleUpdate(() => ({ photo: 'previous-owner-photo' })), false);
  assert.equal(writes, 0);
});

test('queued preference writes stop when their owner unmounts', async () => {
  const pending = deferred<Response>();
  let writes = 0;
  const h = await harness(async (_input, init) => {
    if (init?.method === 'PUT') { writes++; return pending.promise; }
    return Response.json({ layout: {} });
  });
  await h.render('appearance.background');
  let first!: Promise<boolean>, second!: Promise<boolean>;
  await h.act(() => {
    first = h.state.update(() => ({ color: '#112233' }));
    second = h.state.update(() => ({ color: '#223344' }));
  });
  await h.close();
  pending.resolve(Response.json({ ok: true }));
  assert.equal(await first, true);
  assert.equal(await second, false);
  assert.equal(writes, 1, 'the queued request never used the next account session');
});

test('a server-read seed paints first, then gives way to the stored value', async () => {
  const pending = deferred<Response>();
  const h = await harness(async (input) => {
    const scope = new URL(String(input), 'http://localhost').searchParams.get('scope')!;
    return scope === 'slow' ? pending.promise : Response.json({ layout: null });
  });
  try {
    await h.render('slow', undefined, { slow: { marker: 'from-server' } });
    // The whole point: no default paint while the read is in flight.
    assert.deepEqual(h.state.raw, { marker: 'from-server' });
    // A seed is not a read: writing must still wait for one, or a value the
    // server merely believed current would be saved back over the stored one.
    assert.equal(h.state.ready, false);
    assert.equal(await h.state.update(() => ({ marker: 'written' })), false);

    await h.act(async () => { pending.resolve(Response.json({ layout: { marker: 'stored' } })); });
    assert.deepEqual(h.state.raw, { marker: 'stored' }, 'the read wins over the seed');
    assert.equal(h.state.ready, true);
  } finally {
    await h.close();
  }
});

test('a seed belongs to its scope only, and never to a scope-less render', async () => {
  const pending = deferred<Response>();
  const h = await harness(async (input) => {
    const scope = new URL(String(input), 'http://localhost').searchParams.get('scope')!;
    return scope === 'other' ? pending.promise : Response.json({ layout: null });
  });
  try {
    // Seeded for one scope, rendered for another: showing it would paint one
    // workspace's cards inside another.
    await h.render('other', undefined, { 'the-one-seeded': { marker: 'elsewhere' } });
    assert.equal(h.state.raw, null);
    // No scope at all (owner not resolved): nothing to seed either.
    await h.render(null, undefined, { 'the-one-seeded': { marker: 'elsewhere' } });
    assert.equal(h.state.raw, null);
    assert.equal(h.state.ready, false);
  } finally {
    pending.resolve(Response.json({ layout: null }));
    await h.close();
  }
});

/**
 * A recall writes the rows of a whole view out of band — a preset covers
 * scopes whose owner is not even mounted. Every consumer already on screen
 * must therefore re-read, and must NOT take that occasion to hand over its
 * legacy value: the preset may have erased the scope on purpose.
 */
test('a recall makes a mounted consumer re-read its scope', async () => {
  let served = 0;
  const h = await harness(async () => Response.json({ layout: { pass: ++served } }));
  try {
    await h.render('recalled');
    assert.deepEqual(h.state.raw, { pass: 1 });
    const { LAYOUT_RECALLED_EVENT } = await import('./layout-presets');
    await h.act(async () => {
      window.dispatchEvent(new window.CustomEvent(LAYOUT_RECALLED_EVENT));
      await new Promise((done) => setTimeout(done, 0));
    });
    assert.deepEqual(h.state.raw, { pass: 2 }, 'the second read is the recalled value');
  } finally {
    await h.close();
  }
});

test('a recall that erased a scope does not resurrect it from the legacy one', async () => {
  const served: string[] = [];
  const h = await harness(async (input) => {
    const scope = new URL(String(input), 'http://localhost').searchParams.get('scope')!;
    served.push(scope);
    return Response.json({ layout: scope === 'old-columns' ? { from: 'legacy' } : null });
  });
  try {
    await h.render('erased', 'old-columns');
    assert.deepEqual(h.state.raw, { from: 'legacy' }, 'the first read still migrates');
    served.length = 0;
    const { LAYOUT_RECALLED_EVENT } = await import('./layout-presets');
    await h.act(async () => {
      window.dispatchEvent(new window.CustomEvent(LAYOUT_RECALLED_EVENT));
      await new Promise((done) => setTimeout(done, 0));
    });
    assert.equal(h.state.raw, null, 'the erasure survives the re-read');
    assert.deepEqual(served, ['erased'], 'the legacy scope is not consulted again');

    // A scope met for the first time AFTER the recall still migrates: the
    // guard is "this scope was already read", not "a recall happened". Recall
    // a cockpit preset, then open the chat — its columns must still be handed
    // over.
    served.length = 0;
    await h.render('never-read', 'old-columns');
    assert.deepEqual(h.state.raw, { from: 'legacy' }, 'an unvisited scope still migrates');
    assert.deepEqual(served, ['never-read', 'old-columns', 'never-read']);
  } finally {
    await h.close();
  }
});

/**
 * The flash seen on `/` and `/agents`: the server only seeds the route it
 * rendered, and the widget host never remounts, so a click to another view
 * left its scope with no seed and no read — `raw === null`, which the consumer
 * read as "nothing stored" and answered with its factory cards, for the two
 * round trips it takes to resolve the workspace and read its row.
 */
test('a view already read in this document paints from memory, an unread one paints nothing', async () => {
  const pending = deferred<Response>();
  let served: 'now' | 'pending' = 'now';
  const h = await harness(async (input) => {
    const scope = new URL(String(input), 'http://localhost').searchParams.get('scope')!;
    if (scope === 'unvisited-agents') return pending.promise;
    if (scope === 'visited-cockpit' && served === 'pending') return pending.promise;
    return Response.json({ layout: scope === 'visited-cockpit' ? { marker: 'mine' } : null });
  });
  try {
    const { forgetStoredLayouts } = await import('../hooks/use-stored-layout');
    forgetStoredLayouts();
    await h.render('visited-cockpit');
    assert.deepEqual(h.state.raw, { marker: 'mine' });
    assert.equal(h.state.known, true);

    // A scope never read and never seeded: nothing is known, and the consumer
    // must not invent an arrangement while the read is on the wire.
    await h.render('unvisited-agents');
    assert.equal(h.state.raw, null);
    assert.equal(h.state.known, false);

    // Back to the cockpit through a view that DID answer, so the hook no
    // longer holds the cockpit's value in its own state: only memory can
    // paint it, and it paints it with the read no further along than before.
    await h.render('elsewhere');
    served = 'pending';
    await h.render('visited-cockpit');
    assert.deepEqual(h.state.raw, { marker: 'mine' });
    assert.equal(h.state.known, true);

    // A recall rewrites rows out of band: what was memorised is no longer the
    // stored value, so it stops being served.
    await h.render('elsewhere');
    const { LAYOUT_RECALLED_EVENT } = await import('./layout-presets');
    await h.act(async () => {
      window.dispatchEvent(new window.CustomEvent(LAYOUT_RECALLED_EVENT));
      await new Promise((done) => setTimeout(done, 0));
    });
    await h.render('visited-cockpit');
    assert.equal(h.state.raw, null, 'the recall dropped what had been memorised');
    assert.equal(h.state.known, false);
  } finally {
    pending.resolve(Response.json({ layout: null }));
    await h.close();
  }
});

/**
 * TIM-0011: pinning used to write `${viewKey}.nav`, so /agents folded while
 * / stayed open. VerticalNav now reads sharedNavScope and, when that row is
 * still empty, copies the current view leftover through this hook.
 */
test('a missing owner-wide nav row is copied from the pinned view leftover', async () => {
  const { leftoverNavScope, sharedNavScope, workspaceScope } = await import('./workspace-scope');
  const owner = 'owner-a';
  const global = await sharedNavScope(owner);
  const cockpitLeftover = leftoverNavScope(await workspaceScope(owner, '/', null))!;
  const chatLeftover = leftoverNavScope(await workspaceScope(owner, '/chat', null))!;
  const stored = new Map<string, unknown>([[cockpitLeftover, { pinned: true }]]);
  const writes: string[] = [];
  const h = await harness(async (input, init) => {
    const scope = new URL(String(input), 'http://localhost').searchParams.get('scope')!;
    if (init?.method === 'PUT') {
      stored.set(scope, JSON.parse(String(init.body)).layout);
      writes.push(scope);
      return Response.json({ ok: true });
    }
    return Response.json({ layout: stored.get(scope) ?? null });
  });
  try {
    const { forgetStoredLayouts } = await import('../hooks/use-stored-layout');
    forgetStoredLayouts();
    await h.render(global, cockpitLeftover);
    assert.deepEqual(h.state.raw, { pinned: true });
    assert.equal(h.state.ready, true);
    assert.deepEqual(writes, [global], 'the leftover is saved under the owner-wide row');
    assert.deepEqual(stored.get(global), { pinned: true });
    assert.deepEqual(stored.get(cockpitLeftover), { pinned: true }, 'the leftover row is left in place');

    await h.render(global, chatLeftover);
    assert.deepEqual(h.state.raw, { pinned: true }, 'another view of the same owner reads the copied row');
    assert.equal(stored.has(chatLeftover), false);
    assert.deepEqual(writes, [global], 'an empty leftover does not overwrite the copy');
  } finally {
    await h.close();
  }
});

/** A daemon of rows, logging every request as `METHOD scope`. */
function rowsDaemon(initial: ReadonlyArray<readonly [string, unknown]>, refuse: { put?: boolean; get?: string } = {}) {
  const stored = new Map<string, unknown>(initial);
  const requests: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const scope = new URL(String(input), 'http://localhost').searchParams.get('scope')!;
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${scope}`);
    if (method === 'PUT') {
      if (refuse.put) return new Response(null, { status: 503 });
      stored.set(scope, JSON.parse(String(init?.body)).layout);
      return Response.json({ ok: true });
    }
    if (method === 'DELETE') { stored.delete(scope); return Response.json({ ok: true }); }
    if (refuse.get === scope) return new Response(null, { status: 503 });
    return Response.json({ layout: stored.get(scope) ?? null });
  }) as MockFetch;
  return { stored, requests, fetchImpl };
}

/** Lets the erasure fired after a copy reach the daemon. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// TODO #790 (rest of TIM-0137): a remote machine's view written before its
// scopes followed the acting account sits under the key hashed with the local
// id. Its first read copies it under the new key, then erases it.
test('a row stored under the previous key is copied under the new one, then erased', async () => {
  const { rowHandover } = await import('./layout-handover');
  const d = rowsDaemon([['old.widgets', { cards: ['git'] }], ['cockpit', { cards: ['stock'] }]]);
  const h = await harness(d.fetchImpl);
  try {
    await h.render('new.widgets', rowHandover('old.widgets', 'cockpit'));
    await h.act(settle);
    assert.deepEqual(h.state.raw, { cards: ['git'] });
    assert.equal(h.state.ready, true);
    assert.deepEqual(d.requests, ['GET new.widgets', 'GET old.widgets', 'PUT new.widgets', 'DELETE old.widgets'], 'the shared row is not even read');
    assert.deepEqual(d.stored.get('new.widgets'), { cards: ['git'] });
    assert.equal(d.stored.has('old.widgets'), false);
    assert.deepEqual(d.stored.get('cockpit'), { cards: ['stock'] }, 'the shared row stays for the other views');
  } finally { await h.close(); }
});

test('with nothing under the previous key, the shared row is copied and kept', async () => {
  const { rowHandover } = await import('./layout-handover');
  const d = rowsDaemon([['cockpit', { cards: ['stock'] }]]);
  const h = await harness(d.fetchImpl);
  try {
    await h.render('new.widgets', rowHandover('old.widgets', 'cockpit'));
    await h.act(settle);
    assert.deepEqual(h.state.raw, { cards: ['stock'] });
    assert.deepEqual(d.requests, ['GET new.widgets', 'GET old.widgets', 'GET cockpit', 'PUT new.widgets']);
    assert.deepEqual(d.stored.get('cockpit'), { cards: ['stock'] });
  } finally { await h.close(); }
});

test('a new row that already holds something reads no source and erases none', async () => {
  const { rowHandover } = await import('./layout-handover');
  const d = rowsDaemon([['new.strip', { pinned: ['b'] }], ['old.strip', { pinned: ['a'] }]]);
  const h = await harness(d.fetchImpl);
  try {
    await h.render('new.strip', rowHandover('old.strip'));
    await h.act(settle);
    assert.deepEqual(h.state.raw, { pinned: ['b'] });
    assert.deepEqual(d.requests, ['GET new.strip']);
    assert.deepEqual(d.stored.get('old.strip'), { pinned: ['a'] });
  } finally { await h.close(); }
});

test('a copy the daemon refuses erases nothing, and the view cannot write', async () => {
  const { rowHandover } = await import('./layout-handover');
  const d = rowsDaemon([['old.islands', { split: true }]], { put: true });
  const h = await harness(d.fetchImpl);
  try {
    await h.render('new.islands', rowHandover('old.islands'));
    await h.act(settle);
    assert.equal(h.state.ready, false);
    assert.deepEqual(d.requests, ['GET new.islands', 'GET old.islands', 'PUT new.islands']);
    assert.deepEqual(d.stored.get('old.islands'), { split: true });
  } finally { await h.close(); }
});

test('a previous row that cannot be read stops the chain: the shared one is not copied over it', async () => {
  const { rowHandover } = await import('./layout-handover');
  const d = rowsDaemon([['chat.columns', { left: 300 }]], { get: 'old.columns' });
  const h = await harness(d.fetchImpl);
  try {
    await h.render('new.columns', rowHandover('old.columns', 'chat.columns'));
    await h.act(settle);
    assert.equal(h.state.ready, false);
    assert.equal(h.state.raw, null);
    assert.deepEqual(d.requests, ['GET new.columns', 'GET old.columns']);
  } finally { await h.close(); }
});

test('a chain rebuilt at every render is read once', async () => {
  const { rowHandover } = await import('./layout-handover');
  const d = rowsDaemon([['old.nav', { pinned: true }]]);
  const h = await harness(d.fetchImpl);
  try {
    await h.render('new.nav', rowHandover('old.nav'));
    await h.render('new.nav', rowHandover('old.nav'));
    await h.act(settle);
    assert.deepEqual(h.state.raw, { pinned: true });
    assert.deepEqual(d.requests, ['GET new.nav', 'GET old.nav', 'PUT new.nav', 'DELETE old.nav']);
  } finally { await h.close(); }
});

test('the read-ahead of a switch paints the previous row but never erases it', async () => {
  const { rowHandover } = await import('./layout-handover');
  const { forgetStoredLayouts, peekStoredLayout, preloadStoredLayout } = await import('../hooks/use-stored-layout');
  const d = rowsDaemon([['old.appearance', { flat: true }], ['chat.appearance', { flat: false }]]);
  const original = globalThis.fetch;
  globalThis.fetch = d.fetchImpl;
  try {
    forgetStoredLayouts();
    await preloadStoredLayout('new.appearance', rowHandover('old.appearance', 'chat.appearance'));
    assert.deepEqual(peekStoredLayout('new.appearance'), { flat: true });
    assert.deepEqual(d.requests, ['GET new.appearance', 'GET old.appearance']);
    assert.deepEqual(d.stored.get('old.appearance'), { flat: true });
  } finally {
    globalThis.fetch = original;
    forgetStoredLayouts();
  }
});
