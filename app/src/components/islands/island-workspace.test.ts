/**
 * The island workspace mounted with a fake content type: the route's page is
 * never remounted by a split, nothing is painted until something is opened,
 * contents read their place through `useIslandContent`, and a gutter resizes.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { waitUntil } from '@/lib/test-wait';
import { HOST_ROUTE, collectLeaves, defaultIslandTree, insertAt, openFloat, setFloatMinimized, setFloatPinned, type IslandParams, type IslandTree } from '@/lib/island-tree';

const FAKE = 'fixture:board';

async function mount(ctx: TestContext, { width = 1200, height = 800, exclusive = false, keepMounted = false, beforeClose, onClose, viewKey }: { width?: number; height?: number; exclusive?: boolean; keepMounted?: boolean; beforeClose?: (params: IslandParams, tabId: string) => boolean | Promise<boolean>; onClose?: (params: IslandParams, tabId: string) => void; viewKey?: string } = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/kanban', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'MutationObserver']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  Object.defineProperty(dom.window, 'innerWidth', { value: width, configurable: true });
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { get: () => width, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { get: () => height, configurable: true });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const slots = await import('@/lib/plugin-host/slots');
  const tree = await import('@/lib/island-tree');
  const bus = await import('@/lib/island-bus');
  const { IslandWorkspaceView, useIslandRoutePrimary, useIslandRouteFocused } = await import('./island-workspace');
  const { useIslandContent } = await import('./island-content');

  slots.resetSlotsForTests();
  slots.declareSlot('island.content', 'list');
  const mounts: string[] = [];
  const setters = new Map<string, (next: IslandParams) => void>();
  function Board() {
    const { params, active, primary, setParams } = useIslandContent();
    setters.set(String(params.id), setParams);
    React.useEffect(() => { mounts.push(String(params.id)); }, [params.id]);
    return React.createElement('p', { 'data-board': String(params.id), 'data-active': String(active), 'data-primary': String(primary) }, `board ${String(params.id)}`);
  }
  function RoutePage() {
    return React.createElement('div', { id: 'route', 'data-primary': String(useIslandRoutePrimary()), 'data-focused': String(useIslandRouteFocused()) }, 'the page');
  }
  const dispose = slots.register({
    slot: 'island.content',
    pluginId: 'fixture',
    key: 'board',
    island: {
      title: 'Board',
      parseParams: (raw) => {
        const id = (raw as { id?: unknown } | null)?.id;
        return typeof id === 'string' ? { id } : null;
      },
      singletonBy: 'id',
      ...(exclusive ? { exclusive: 'boards' } : {}),
      ...(keepMounted ? { keepMounted: true } : {}),
      ...(beforeClose ? { beforeClose } : {}),
      ...(onClose ? { onClose } : {}),
    },
  }, Board);

  const calls: { tree: IslandTree; persist: boolean }[] = [];
  let setTree: (next: IslandTree) => void = () => {};
  let announce = false;
  function Harness({ initial }: { initial: IslandTree }) {
    const [current, set] = React.useState(initial);
    setTree = set;
    return React.createElement(IslandWorkspaceView, {
      tree: current,
      onTree: (next: IslandTree, persist: boolean) => { calls.push({ tree: next, persist }); set(next); },
      route: React.createElement(RoutePage),
      routeTitle: 'Kanban',
      className: 'rooks-island flex min-h-0 flex-1 flex-col',
      announce,
      ...(exclusive ? { routeExclusive: 'boards' } : {}),
      ...(viewKey ? { viewKey } : {}),
    });
  }
  const root = createRoot(document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  const render = (initial: IslandTree, withAnnounce = false) => {
    announce = withAnnounce;
    return act(() => { root.render(React.createElement(Harness, { initial })); });
  };
  ctx.after(async () => {
    await act(() => root.unmount());
    dispose();
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  const workspace = () => document.querySelector<HTMLElement>('[data-island-workspace]')!;
  return { act, render, calls, tree, bus, mounts, setters, workspace, set: (next: IslandTree) => act(() => setTree(next)) };
}

test('nothing is painted around the page until something is opened', async (t) => {
  const w = await mount(t);
  await w.render(w.tree.defaultIslandTree());
  const ws = w.workspace();
  assert.equal(ws.dataset.islandWorkspace, 'single');
  assert.equal(ws.className, 'rooks-island flex min-h-0 flex-1 flex-col', 'the frame the page always had');
  assert.equal(ws.getAttribute('style'), null);
  assert.ok(document.getElementById('route'));
  assert.ok(!document.querySelector('[data-island]'));
  assert.ok(!document.querySelector('[role="tablist"]'));
  assert.ok(!document.querySelector('[role="separator"]'));
});

test('splitting keeps the very same page node, paints islands, and confines the page', async (t) => {
  const w = await mount(t);
  const base = w.tree.defaultIslandTree();
  await w.render(base);
  const page = document.getElementById('route');
  const split = w.tree.insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'q3' } }).tree;
  await w.set(split);
  assert.equal(document.getElementById('route'), page, 'the page was not remounted');
  const ws = w.workspace();
  assert.equal(ws.dataset.islandWorkspace, 'split');
  assert.match(ws.className, /rooks-island-backdrop/);
  assert.match(ws.className, /\bisolate\b/, 'its layers never stack above the nav rail or the top bar');
  assert.equal(document.getElementById('route')!.parentElement!.style.getPropertyValue('--rooks-nav-w'), '0px', 'the page is confined');
  assert.equal(document.querySelectorAll('[data-island]').length, 2);
  assert.ok(document.querySelector('[data-board="q3"]'), 'the content reads its params');
  const ring = document.querySelectorAll<HTMLElement>('[data-island-focus-ring]');
  assert.equal(ring.length, 1, 'one focus ring, the focused island\'s');
  assert.match(ring[0]!.className, /ring-inset/, 'drawn inside: nothing around the island can cut it');
  assert.match(document.body.textContent ?? '', /Kanban/);
  assert.match(document.body.textContent ?? '', /Board/);
  const separator = document.querySelector<HTMLElement>('[role="separator"]')!;
  assert.equal(separator.getAttribute('aria-orientation'), 'vertical');
  assert.match(separator.className, /cursor-col-resize/);
  // Back to one island: the page is still the same node.
  await w.set(base);
  assert.equal(document.getElementById('route'), page);
  assert.equal(w.workspace().dataset.islandWorkspace, 'single');
});

test('a view whose page asks for no focus ring paints none, whichever island is clicked', async (t) => {
  const w = await mount(t);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const slots = await import('@/lib/plugin-host/slots');
  const { PathnameContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { IslandWorkspaceView } = await import('./island-workspace');
  slots.declareSlot('page', 'keyed');
  const disposePage = slots.register({ slot: 'page', pluginId: 'fixture', key: '/native', page: { focusRing: false } }, () => null);
  const base = w.tree.defaultIslandTree();
  const split = w.tree.insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'n1' } }).tree;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const show = (pathname: string, tree: IslandTree) => w.act(() => {
    root.render(React.createElement(PathnameContext.Provider, { value: pathname },
      React.createElement(IslandWorkspaceView, { tree, onTree: () => {}, route: React.createElement('div', { id: 'native-route' }), routeTitle: 'Native' })));
  });

  await show('/native', split);
  assert.equal(host.querySelectorAll('[data-island]').length, 2, 'split: two islands');
  assert.equal(host.querySelectorAll('[data-island-focus-ring]').length, 0, 'no ring around the focused island');
  const other = collectLeaves(split.root).find((leaf) => leaf.id !== split.focus)!;
  await show('/native', { ...split, focus: other.id });
  assert.equal(host.querySelectorAll('[data-island-focus-ring]').length, 0, 'nor around the other one once focused');
  // Any other view keeps its ring: the option belongs to the page that sets it.
  await show('/kanban', split);
  assert.equal(host.querySelectorAll('[data-island-focus-ring]').length, 1);
  await w.act(() => root.unmount());
  disposePage();
});

test('a view whose page asks for a bare route paints no tab bar over the page, until a second tab joins it', async (t) => {
  const w = await mount(t);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const slots = await import('@/lib/plugin-host/slots');
  const { PathnameContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { IslandWorkspaceView } = await import('./island-workspace');
  slots.declareSlot('page', 'keyed');
  const disposePage = slots.register({ slot: 'page', pluginId: 'fixture', key: '/native', page: { bareRoute: true } }, () => null);
  const base = w.tree.defaultIslandTree();
  const split = w.tree.insertAt(base, base.root.id, 'left', { type: FAKE, params: { id: 'rail' } }).tree;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const show = (pathname: string, tree: IslandTree) => w.act(() => {
    root.render(React.createElement(PathnameContext.Provider, { value: pathname },
      React.createElement(IslandWorkspaceView, { tree, onTree: () => {}, route: React.createElement('div', { id: 'native-route' }), routeTitle: 'Native' })));
  });

  await show('/native', split);
  assert.equal(host.querySelectorAll('[data-island]').length, 2);
  assert.ok(!(host.textContent ?? '').includes('Native'), 'no tab names the page');
  assert.ok((host.textContent ?? '').includes('Board'), 'the other island keeps its header');
  const page = host.querySelector<HTMLElement>('#native-route')!.parentElement!;
  assert.equal(page.style.borderTopLeftRadius, 'var(--rooks-island-radius)', 'the page holds the island\'s top corners');
  // A second tab in the page's island: the bar is back, to pick between them.
  const routeId = collectLeaves(split.root).find((leaf) => leaf.tabs.some((tab) => tab.content.type === HOST_ROUTE))!.id;
  await show('/native', w.tree.addTab(split, routeId, { type: FAKE, params: { id: 'second' } }).tree);
  assert.equal(host.querySelectorAll('[role="tablist"]').length, 1, 'the page\'s island has a tab bar again');
  assert.ok((host.textContent ?? '').includes('Native'));
  // Another view keeps the page's header.
  await show('/kanban', split);
  assert.ok((host.textContent ?? '').includes('Native'));
  await w.act(() => root.unmount());
  disposePage();
});

test('a gutter resizes from the keyboard and writes once per step', async (t) => {
  const w = await mount(t);
  const base = w.tree.defaultIslandTree();
  await w.render(w.tree.insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'a' } }).tree);
  const separator = document.querySelector<HTMLElement>('[role="separator"]')!;
  await w.act(() => { separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
  const last = w.calls.at(-1)!;
  assert.equal(last.persist, true);
  assert.equal(last.tree.root.kind, 'split');
  assert.deepEqual(last.tree.root.kind === 'split' ? last.tree.root.ratios.map((r) => Math.round(r * 100)) : [], [52, 48]);
  assert.equal(separator.getAttribute('aria-valuenow'), '52');
});

test('a tab whose type is not registered waits, and can be closed', async (t) => {
  const w = await mount(t);
  const base = w.tree.defaultIslandTree();
  await w.render(w.tree.insertAt(base, base.root.id, 'bottom', { type: '@gone/plugin:view', params: {} }).tree);
  assert.match(document.body.textContent ?? '', /Content unavailable — @gone\/plugin/);
  const close = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Close')!;
  await w.act(() => { close.click(); });
  assert.ok(w.tree.isDefaultIslandTree(w.calls.at(-1)!.tree));
});

test('an inactive tab is unmounted; the route page always stays', async (t) => {
  const w = await mount(t);
  const base = w.tree.defaultIslandTree();
  await w.render(w.tree.addTab(base, base.root.id, { type: FAKE, params: { id: 'a' } }).tree);
  assert.ok(document.querySelector('[data-board="a"]'));
  assert.ok(document.getElementById('route'), 'hidden, still mounted');
  const routeTab = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find((b) => b.textContent === 'Kanban')!;
  await w.act(() => { routeTab.click(); });
  assert.ok(!document.querySelector('[data-board="a"]'), 'the board left the DOM');
  const host = document.getElementById('route')!.parentElement!;
  assert.doesNotMatch(host.className, /(^|\s)hidden(\s|$)/);
});

test('below 768 px the workspace stacks: one content, every tab in a picker', async (t) => {
  const w = await mount(t, { width: 600 });
  const base = w.tree.defaultIslandTree();
  await w.render(w.tree.insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'a' } }).tree);
  assert.equal(w.workspace().dataset.islandWorkspace, 'stacked');
  assert.equal(document.querySelectorAll('[role="tab"]').length, 2);
  assert.ok(!document.querySelector('[role="separator"]'));
  assert.ok(document.querySelector('[data-board="a"]'), 'the focused island is shown');
  // In the flow: a phone's folding top bar must not make it chase a measured box.
  assert.match(w.workspace().className, /\bflex-col\b/);
  const wrapper = document.querySelector('[data-board="a"]')!.closest<HTMLElement>('[data-island-tab]')!;
  assert.match(wrapper.className, /\bflex-1\b/);
  assert.doesNotMatch(wrapper.className, /\babsolute\b/);
  assert.equal(wrapper.style.top, '', 'no top computed from the measured box');
});

test('stacked for lack of room, a tab keeps its menu and its drag, within its own island', async (t) => {
  // Wide enough not to be a phone, too narrow for four islands of 280 px.
  const w = await mount(t, { width: 900 });
  const base = w.tree.defaultIslandTree();
  const two = w.tree.insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'a' } }).tree;
  const withB = w.tree.addTab(two, two.focus!, { type: FAKE, params: { id: 'b' } }).tree;
  const three = w.tree.insertAt(withB, withB.focus!, 'right', { type: FAKE, params: { id: 'c' } }).tree;
  const four = w.tree.insertAt(three, three.focus!, 'right', { type: FAKE, params: { id: 'd' } }).tree;
  await w.render(four);
  assert.equal(w.workspace().dataset.islandWorkspace, 'stacked');
  const name = (tab: { content: { params: IslandParams } }) => String(tab.content.params.id ?? 'route');
  const current = () => w.calls.at(-1)?.tree ?? four;
  const order = () => w.tree.allLeaves(current()).map((leaf) => leaf.tabs.map(name));
  const handle = (n: string) => {
    const id = w.tree.allLeaves(current()).flatMap((leaf) => leaf.tabs).find((tab) => name(tab) === n)!.id;
    return document.querySelector<HTMLElement>(`[data-island-tab-handle="${id}"]`)!;
  };
  const menuOn = (n: string) => w.act(() => { handle(n).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
  assert.deepEqual(order(), [['route'], ['a', 'b'], ['c'], ['d']]);

  // Right click: the island header's menu, minus what needs a painted island.
  await menuOn('a');
  assert.ok(!document.querySelector('[data-stack-menu-item="earlier"]'), 'its left neighbour is another island: never joined from here');
  assert.ok(document.querySelector('[data-stack-menu-item="close"]'));
  assert.ok(!document.querySelector('[data-stack-menu-item="detach"]'), 'no Detach for a type without one');
  await w.act(() => { document.querySelector<HTMLElement>('[data-stack-menu-item="later"]')!.click(); });
  assert.deepEqual(order(), [['route'], ['b', 'a'], ['c'], ['d']], 'the keyboard twin of the drag');

  // The page's tab: no Close, no move.
  await menuOn('route');
  assert.ok(!document.querySelector('[data-stack-menu-item="close"]'));
  assert.ok(!document.querySelector('[data-stack-menu-item="later"]'));
  await w.act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

  // Dragged on a tab of its island, it lands before it.
  assert.equal(handle('a').getAttribute('draggable'), 'true');
  const dt = fakeTransfer();
  await w.act(async () => { handle('a').dispatchEvent(dragEvent('dragstart', dt)); await tick(); });
  const writes = w.calls.length;
  await w.act(async () => { handle('c').dispatchEvent(dragEvent('dragover', dt)); await tick(); });
  assert.equal(handle('c').dataset.stackDrop, undefined, 'another island is no target');
  await w.act(async () => { handle('c').dispatchEvent(dragEvent('drop', dt)); await tick(); });
  assert.equal(w.calls.length, writes, 'nothing written');
  await w.act(async () => { handle('b').dispatchEvent(dragEvent('dragover', dt)); await tick(); });
  assert.equal(handle('b').dataset.stackDrop, '', 'where it lands is shown');
  await w.act(async () => { handle('b').dispatchEvent(dragEvent('drop', dt)); await tick(); });
  assert.deepEqual(order(), [['route'], ['a', 'b'], ['c'], ['d']]);
});

test('an announced workspace opens a content next to the focused island, once', async (t) => {
  const w = await mount(t);
  assert.equal(w.bus.openInIsland({ type: FAKE, params: { id: 'a' } }), false, 'no workspace: refused');
  await w.render(w.tree.defaultIslandTree(), true);
  let opened = false;
  await w.act(() => { opened = w.bus.openInIsland({ type: FAKE, params: { id: 'a' } }, { edge: 'right' }); });
  assert.equal(opened, true);
  assert.equal(w.workspace().dataset.islandWorkspace, 'split');
  // Same singleton value: activated where it is, not opened twice.
  await w.act(() => { w.bus.openInIsland({ type: FAKE, params: { id: 'a' } }, { edge: 'center' }); });
  assert.equal(document.querySelectorAll('[data-board="a"]').length, 1);
  // Params refused by the type: nothing opens.
  await w.act(() => { opened = w.bus.openInIsland({ type: FAKE, params: { id: 3 } }); });
  assert.equal(opened, false);
  assert.ok(w.mounts.includes('a'));
});

test('the stored workspace, before its view key is known, is the frame alone and offers nothing', async (t) => {
  const w = await mount(t);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { IslandWorkspace } = await import('./island-workspace');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await w.act(() => {
    root.render(React.createElement(IslandWorkspace, {
      className: 'rooks-island flex min-h-0 flex-1 flex-col',
      route: React.createElement('div', { id: 'stored-route' }, 'page'),
    }));
  });
  const ws = host.querySelector<HTMLElement>('[data-island-workspace]')!;
  assert.equal(ws.dataset.islandWorkspace, 'single');
  assert.equal(ws.className, 'rooks-island flex min-h-0 flex-1 flex-col');
  assert.ok(host.querySelector('#stored-route'));
  assert.equal(w.bus.openInIsland({ type: FAKE, params: { id: 'a' } }), false, 'nothing read yet: not announced');
  await w.act(() => root.unmount());
});

/**
 * The stored workspace behind a daemon that answers like the real one: a
 * `PUT` of `null` is refused (400), a `DELETE` forgets the row. Every write is
 * recorded, and `toast.error` is watched for the "Could not save" toast.
 * `versioned`: rows carry their version, and a write made on an older one is
 * refused (409) — two windows on the same view (TODO #647).
 */
async function mountStored(t: TestContext, owner: string, stored: (scopes: { islands: string; pinned: string }) => Array<[string, unknown]>, { versioned = false }: { versioned?: boolean } = {}) {
  const w = await mount(t);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PathnameContext, SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WorkspaceLayoutProvider } = await import('@/components/workspace-layout-provider');
  const { IslandWorkspace, ISLANDS_SUFFIX } = await import('./island-workspace');
  const { workspaceScope, sharedPinnedIslandsScope } = await import('@/lib/workspace-scope');
  const { toast } = await import('sonner');
  // A view of its own per test: the provider remembers a resolved route for
  // the life of the module, with the key of whoever resolved it first.
  const view = `/kanban/${owner}`;
  const scopes = {
    islands: `${await workspaceScope(owner, view, null)}.${ISLANDS_SUFFIX}`,
    pinned: await sharedPinnedIslandsScope(owner),
  };
  const rows = new Map<string, unknown>(stored(scopes));
  const writes: { method: string; scope: string; layout?: unknown }[] = [];
  let clock = 0;
  const versions = new Map<string, number>([...rows.keys()].map((scope) => [scope, ++clock]));
  /** What another window writes meanwhile. */
  const elsewhere = (scope: string, layout: unknown) => { rows.set(scope, layout); versions.set(scope, ++clock); };
  // Scopes whose stored row the workspace has read: the stored layout arrives
  // after chained reads (identity, scope, row), never at a fixed delay.
  const read = new Set<string>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/ui/auth/me') return Response.json({ user: { id: owner } });
    const scope = url.searchParams.get('scope') ?? '';
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      const response = Response.json({ layout: rows.get(scope) ?? null, ...(versioned ? { updatedAt: versions.get(scope) ?? null } : {}) });
      const body = response.json.bind(response);
      response.json = async () => { const layout: unknown = await body(); read.add(scope); return layout; };
      return response;
    }
    const expected = url.searchParams.get('expected');
    const stale = versioned && expected !== null && (expected === 'none' ? versions.has(scope) : Number(expected) !== versions.get(scope));
    if (method === 'DELETE') {
      writes.push({ method, scope });
      if (stale) return Response.json({ error: 'conflict' }, { status: 409 });
      rows.delete(scope); versions.delete(scope);
      return Response.json({ ok: true, updatedAt: null });
    }
    const layout = (JSON.parse(String(init?.body)) as { layout: unknown }).layout;
    writes.push({ method, scope, layout });
    if (layout === null) return Response.json({ error: 'layout is required' }, { status: 400 });
    if (stale) return Response.json({ error: 'conflict' }, { status: 409 });
    rows.set(scope, layout);
    versions.set(scope, ++clock);
    return Response.json({ ok: true, updatedAt: clock });
  }) as typeof fetch;
  const toasts = t.mock.method(toast, 'error', () => '');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const until = (condition: () => boolean, what: string) => waitUntil(w.act, condition, what);
  await w.act(() => {
    root.render(React.createElement(PathnameContext.Provider, { value: view },
      React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams() as never },
        React.createElement(WorkspaceLayoutProvider, null,
          React.createElement(IslandWorkspace, { route: React.createElement('div', { id: 'stored-route' }, 'page') })))));
  });
  await until(() => read.has(scopes.islands) && read.has(scopes.pinned), 'the stored rows to be read');
  // One more turn: the hook applies a row after reading it.
  await until(() => true, 'the stored layout to be applied');
  // Called by the test itself: `mount`'s own cleanup, registered first, tears
  // the DOM down, and this root must be gone before it does.
  const close = async () => {
    await w.act(() => root.unmount());
    globalThis.fetch = originalFetch;
  };
  const closeBoard = async () => {
    // An island's single tab closes from the window's own cross, docked or popup;
    // the island holding the page has none.
    const close = host.querySelector<HTMLButtonElement>('button[aria-label="Close Board"]')
      ?? host.querySelector<HTMLButtonElement>('[data-island] [data-island-close]');
    assert.ok(close, 'the board has a close button');
    const before = writes.length;
    await w.act(() => { close.click(); });
    await until(() => writes.length > before, 'closing the board to be stored');
  };
  return { w, host, scopes, rows, writes, until, elsewhere, toasts: () => toasts.mock.callCount(), closeBoard, close };
}

test('closing the last island of a stored view erases its row instead of writing null', async (t) => {
  const s = await mountStored(t, 'owner-close-island', ({ islands }) => {
    const base = defaultIslandTree();
    return [[islands, insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'chat' } }).tree]];
  });
  try {
    assert.equal(s.host.querySelector<HTMLElement>('[data-island-workspace]')!.dataset.islandWorkspace, 'split');
    await s.closeBoard();
    assert.equal(s.host.querySelector<HTMLElement>('[data-island-workspace]')!.dataset.islandWorkspace, 'single');
    assert.deepEqual(s.writes.filter((r) => r.scope === s.scopes.islands), [{ method: 'DELETE', scope: s.scopes.islands }]);
    assert.ok(!s.writes.some((r) => r.method === 'PUT' && r.layout === null), 'no PUT of null');
    assert.equal(s.rows.has(s.scopes.islands), false, 'the row is gone: nothing comes back at the next load');
    assert.equal(s.toasts(), 0, 'no "Could not save" toast');
  } finally { await s.close(); }
});

test('closing the last pinned popup erases the account\'s pinned row', async (t) => {
  const s = await mountStored(t, 'owner-close-pinned', ({ pinned }) => {
    const opened = openFloat(defaultIslandTree(), { type: FAKE, params: { id: 'web' } }, { x: 0.3, y: 0.3, width: 0.4, height: 0.4 }).tree;
    const withPin = setFloatPinned(opened, opened.floats![0]!.leaf.id, true).tree;
    return [[pinned, { v: 1, floats: withPin.floats }]];
  });
  try {
    assert.ok(s.host.querySelector('[data-board="web"]'), 'the pinned popup is shown');
    await s.closeBoard();
    assert.ok(!s.host.querySelector('[data-board="web"]'));
    assert.deepEqual(s.writes.filter((r) => r.scope === s.scopes.pinned), [{ method: 'DELETE', scope: s.scopes.pinned }]);
    assert.ok(!s.writes.some((r) => r.method === 'PUT' && r.layout === null), 'no PUT of null, on either row');
    assert.equal(s.rows.has(s.scopes.pinned), false);
    assert.equal(s.toasts(), 0);
  } finally { await s.close(); }
});

test('closing one island of three still stores the remaining tree with a PUT', async (t) => {
  const s = await mountStored(t, 'owner-close-one', ({ islands }) => {
    const base = defaultIslandTree();
    const one = insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'chat' } }).tree;
    return [[islands, insertAt(one, one.root.kind === 'split' ? one.root.children[0]!.id : one.root.id, 'bottom', { type: '@gone/plugin:view', params: {} }).tree]];
  });
  try {
    await s.closeBoard();
    const own = s.writes.filter((r) => r.scope === s.scopes.islands);
    assert.equal(own.length, 1);
    assert.equal(own[0]!.method, 'PUT');
    assert.notEqual(own[0]!.layout, null);
    assert.ok(collectLeaves((s.rows.get(s.scopes.islands) as IslandTree).root).length === 2, 'the page and the waiting island remain');
    assert.equal(s.toasts(), 0);
  } finally { await s.close(); }
});

/**
 * TODO #647: another window added an island after this one read the view.
 * Closing a board here is refused (409); the close is replayed on the tree
 * read again, so the other window's island stays and the board still goes.
 */
test('a close refused because another window rewrote the view is replayed on its tree', async (t) => {
  const base = defaultIslandTree();
  const mine = insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'chat' } }).tree;
  const s = await mountStored(t, 'owner-replayed-close', ({ islands }) => [[islands, mine]], { versioned: true });
  try {
    const routeLeaf = collectLeaves(mine.root).find((leaf) => leaf.tabs.some((tab) => tab.content.type === HOST_ROUTE))!;
    const theirs = insertAt(mine, routeLeaf.id, 'bottom', { type: '@gone/plugin:view', params: {} }).tree;
    s.elsewhere(s.scopes.islands, theirs);
    await s.closeBoard();
    await s.until(() => s.writes.filter((r) => r.scope === s.scopes.islands).length === 2, 'the replayed write');
    const own = s.writes.filter((r) => r.scope === s.scopes.islands);
    // On this window's copy the board was the last island: its close erases the row.
    assert.deepEqual(own.map((r) => r.method), ['DELETE', 'PUT'], 'refused once, then written on the tree read again');
    const stored = s.rows.get(s.scopes.islands) as IslandTree;
    const types = collectLeaves(stored.root).flatMap((leaf) => leaf.tabs.map((tab) => tab.content.type));
    assert.deepEqual(types.sort(), ['@gone/plugin:view', HOST_ROUTE].sort(), 'their island kept, the board closed');
    assert.ok(!s.host.querySelector('[data-board="chat"]'), 'the board stays closed on screen');
    assert.equal(s.toasts(), 0, 'no "Could not save" toast');
  } finally { await s.close(); }
});

test('the chat drops its underlay once the workspace paints islands, without remounting', async (t) => {
  const w = await mount(t);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { IslandWorkspaceView } = await import('./island-workspace');
  const { ChatIslandUnderlay } = await import('@/components/chat/chat-island-host');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const base = w.tree.defaultIslandTree();
  const view = (tree: IslandTree) => React.createElement(IslandWorkspaceView, {
    tree,
    onTree: () => {},
    className: 'contents',
    route: React.createElement('div', { id: 'chat-body' }, React.createElement(ChatIslandUnderlay)),
  });
  await w.act(() => { root.render(view(base)); });
  const body = host.querySelector('#chat-body');
  assert.ok(host.querySelector('#chat-body > div[aria-hidden]'), 'alone: the underlay paints the island');
  await w.act(() => { root.render(view(w.tree.insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'a' } }).tree)); });
  assert.equal(host.querySelector('#chat-body'), body);
  assert.ok(!host.querySelector('#chat-body > div[aria-hidden]'), 'split: islands paint themselves');
  await w.act(() => root.unmount());
});

test('a stored split renders as islands on its first paint, not as the stacked picker, and the route tab id is constant', async (t) => {
  const w = await mount(t);
  const React = await import('react');
  const { renderToString } = await import('react-dom/server');
  const { IslandWorkspaceView } = await import('./island-workspace');
  const base = w.tree.defaultIslandTree();
  const split = w.tree.insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'a' } }).tree;
  const html = (tree: IslandTree) => renderToString(React.createElement(IslandWorkspaceView, {
    tree, onTree: () => {}, route: React.createElement('div', null, 'page'),
  }));
  assert.match(html(split), /data-island-workspace="split"/, 'nothing measured yet: not stacked');
  assert.equal(html(w.tree.defaultIslandTree()), html(w.tree.defaultIslandTree()), 'two default trees, same markup (hydration)');
});

// ------------------------------------------------------------ drag & drop

/** jsdom has no DataTransfer: what a drag carries, by type. */
function fakeTransfer() {
  const data = new Map<string, string>();
  return {
    types: [] as string[],
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    setData(type: string, value: string) { data.set(type, value); if (!this.types.includes(type)) this.types.push(type); },
    getData(type: string) { return data.get(type) ?? ''; },
  };
}

function dragEvent(type: string, dataTransfer: unknown, x = 0, y = 0): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  return event;
}

const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

test('a content dragged onto the bottom of an island stacks under it, with a preview first', async (t) => {
  const w = await mount(t);
  const drag = await import('@/lib/island-drag');
  t.after(() => drag.resetIslandDragForTests());
  const base = w.tree.defaultIslandTree();
  await w.render(w.tree.insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'a' } }).tree, true);
  const dt = fakeTransfer();
  // Outside `act`, checked before any await: nothing renders during dragstart itself.
  drag.startIslandDrag({ dataTransfer: dt as unknown as DataTransfer }, { type: FAKE, params: { id: 'n' } });
  assert.ok(dt.types.includes(drag.ISLAND_DRAG_TYPE));
  assert.ok(!document.querySelector('[data-island-drop-layer]'), 'not raised during dragstart: Chromium would abort');
  await w.act(tick);
  const layer = document.querySelector<HTMLElement>('[data-island-drop-layer]')!;
  assert.ok(layer, 'raised one tick later');
  // 1200 × 800, gap 8: the page is the left island, 0..596; its body starts under the 32 px header.
  await w.act(() => { layer.dispatchEvent(dragEvent('dragover', dt, 300, 760)); });
  assert.equal(document.querySelector<HTMLElement>('[data-island-drop-preview]')!.dataset.islandDropPreview, 'bottom');
  assert.equal(document.querySelector('[data-island-drop-label]')!.textContent, 'Stack below Kanban');
  assert.equal(dt.dropEffect, 'move');
  await w.act(() => { layer.dispatchEvent(dragEvent('drop', dt, 300, 760)); });
  const after = w.calls.at(-1)!.tree;
  const left = after.root.kind === 'split' ? after.root.children[0]! : after.root;
  assert.equal(left.kind === 'split' ? left.dir : '', 'column', 'stacked');
  assert.match(document.body.textContent ?? '', /Board opened below Kanban/);
  await w.act(tick);
  assert.ok(!document.querySelector('[data-island-drop-layer]'), 'the layer is gone once the drop is over');
});

test('a drop that changes nothing, or a forged one, is refused', async (t) => {
  const w = await mount(t);
  const drag = await import('@/lib/island-drag');
  t.after(() => drag.resetIslandDragForTests());
  const base = w.tree.defaultIslandTree();
  const split = w.tree.insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'a' } }).tree;
  const right = w.tree.collectLeaves(split.root)[1]!.id;
  await w.render(w.tree.addTab(split, right, { type: FAKE, params: { id: 'b' } }).tree, true);
  const tabB = Array.from(document.querySelectorAll<HTMLElement>('[data-island-tab-handle]')).find((h) => h.getAttribute('draggable') === 'true' && h.querySelector('[aria-selected="true"]'))!;
  const dt = fakeTransfer();
  await w.act(async () => { tabB.dispatchEvent(dragEvent('dragstart', dt)); await tick(); });
  const layer = document.querySelector<HTMLElement>('[data-island-drop-layer]')!;
  // Onto the body of its own island: nothing would change.
  await w.act(() => { layer.dispatchEvent(dragEvent('dragover', dt, 900, 400)); });
  assert.equal(document.querySelector('[data-island-drop-label]')!.textContent, 'Already here');
  assert.ok(!document.querySelector('[data-island-drop-preview]'));
  assert.equal(dt.dropEffect, 'none');
  const calls = w.calls.length;
  // Same type, another nonce: a drag forged elsewhere.
  const forged = fakeTransfer();
  forged.setData(drag.ISLAND_DRAG_TYPE, 'not-ours');
  await w.act(() => { layer.dispatchEvent(dragEvent('drop', forged, 300, 760)); });
  assert.equal(w.calls.length, calls, 'nothing written');
});

function pointer(type: string, x: number, y: number): Event {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
}

test('an island moved by its title becomes a popup that follows the pointer, and draws nothing in mid-page', async (t) => {
  const w = await mount(t);
  const drag = await import('@/lib/island-drag');
  t.after(() => drag.resetIslandDragForTests());
  const base = w.tree.defaultIslandTree();
  const initial = w.tree.insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'a' } }).tree;
  await w.render(initial, true);
  const board = Array.from(document.querySelectorAll<HTMLElement>('[data-island-tab-handle]')).find((h) => h.textContent?.includes('Board'))!;
  assert.equal(board.getAttribute('draggable'), null, 'a window, not an HTML5 drag');
  await w.act(() => { board.dispatchEvent(pointer('pointerdown', 700, 16)); });
  const before = w.calls.length;
  await w.act(() => { window.dispatchEvent(pointer('pointermove', 702, 16)); });
  assert.equal(w.calls.length, before, 'under the threshold: still a click');
  assert.ok(!document.querySelector('[data-island-window-move]'));

  await w.act(() => { window.dispatchEvent(pointer('pointermove', 400, 300)); });
  const moving = w.calls.at(-1)!;
  assert.equal(moving.persist, false, 'nothing written while it moves');
  assert.equal(moving.tree.floats?.length, 1, 'torn off into a popup at once');
  assert.ok(document.querySelector('[data-island-window-move]'), 'a layer keeps the pointer from iframes');
  assert.ok(!document.querySelector('[data-island-drop-preview]'), 'no target drawn in mid-page');
  assert.ok(!document.querySelector('[data-island-drop-layer]'), 'no HTML5 drop layer');
  await w.act(() => { window.dispatchEvent(pointer('pointermove', 420, 320)); });
  const x1 = w.calls.at(-1)!.tree.floats![0]!.rect.x;
  assert.ok(Math.abs(x1 - moving.tree.floats![0]!.rect.x - 20 / 1200) < 1e-6, 'the popup follows the pointer');

  const writes = w.calls.length;
  await w.act(() => { window.dispatchEvent(pointer('pointerup', 420, 320)); });
  assert.equal(w.calls.length, writes + 1, 'written once, on release');
  assert.equal(w.calls.at(-1)!.persist, true);
  assert.equal(w.calls.at(-1)!.tree.floats?.length, 1, 'left where it is, a popup');
  assert.ok(!document.querySelector('[data-island-window-move]'));
});

test('a window pressed against the screen\'s border shows where it docks, and docks there on release', async (t) => {
  const w = await mount(t);
  const drag = await import('@/lib/island-drag');
  t.after(() => drag.resetIslandDragForTests());
  const base = w.tree.defaultIslandTree();
  await w.render(w.tree.insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'a' } }).tree, true);
  const board = () => Array.from(document.querySelectorAll<HTMLElement>('[data-island-tab-handle]')).find((h) => h.textContent?.includes('Board'))!;
  await w.act(() => { board().dispatchEvent(pointer('pointerdown', 700, 16)); });
  await w.act(() => { window.dispatchEvent(pointer('pointermove', 600, 400)); });
  assert.ok(!document.querySelector('[data-island-drop-preview]'));
  await w.act(() => { window.dispatchEvent(pointer('pointermove', 3, 400)); });
  assert.equal(document.querySelector<HTMLElement>('[data-island-drop-preview]')!.dataset.islandDropPreview, 'root:left');
  const popupId = w.calls.at(-1)!.tree.floats![0]!.leaf.id;
  const chassis = document.querySelector<HTMLElement>(`[data-island="${popupId}"]`)!;
  assert.equal(w.calls.at(-1)!.tree.floats![0]!.rect.x, 0, 'the stored popup stays inside the workspace');
  assert.match(chassis.style.transform, /^translate\(-93px, \d+px\)$/, 'painted past it, under the pointer');
  const snap = document.querySelector<HTMLElement>('[data-island-window-snap]')!;
  assert.ok(Number(snap.style.zIndex) < Number(chassis.style.zIndex), 'the square sits under the moved window');
  await w.act(() => { window.dispatchEvent(pointer('pointermove', 400, 200)); });
  assert.equal(chassis.style.transform, '', 'back inside: no shift');
  assert.ok(!document.querySelector('[data-island-drop-preview]'), 'back in mid-page: the square goes');
  await w.act(() => { window.dispatchEvent(pointer('pointermove', 3, 400)); });
  await w.act(() => { window.dispatchEvent(pointer('pointerup', 3, 400)); });
  const after = w.calls.at(-1)!;
  assert.equal(after.persist, true);
  assert.equal(after.tree.floats?.length ?? 0, 0, 'docked, no popup left');
  const leaves = w.tree.collectLeaves(after.tree.root);
  assert.equal(leaves[0]!.tabs[0]!.content.type, FAKE, 'docked along the left edge');
  assert.match(document.body.textContent ?? '', /Board opened along the edge of the workspace/);

  // Escape puts everything back as it was before the press.
  const docked = after.tree;
  await w.act(() => { board().dispatchEvent(pointer('pointerdown', 100, 16)); });
  await w.act(() => { window.dispatchEvent(pointer('pointermove', 600, 400)); });
  assert.equal(w.calls.at(-1)!.tree.floats?.length, 1);
  await w.act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  assert.deepEqual(w.calls.at(-1)!.tree, docked);
  assert.ok(!document.querySelector('[data-island-window-move]'));
});

test('a popup has eight resize handles above its content; the left edge resizes, the right side stays', async (t) => {
  const w = await mount(t);
  const drag = await import('@/lib/island-drag');
  t.after(() => drag.resetIslandDragForTests());
  const base = w.tree.defaultIslandTree();
  const popup = w.tree.openFloat(base, { type: FAKE, params: { id: 'p' } }, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }).tree;
  await w.render(popup, true);
  const handles = document.querySelectorAll<HTMLElement>('[data-island-float-resize-handle]');
  assert.equal(handles.length, 8);
  const frame = document.querySelector<HTMLElement>('[data-island-float-resize]')!;
  const leafId = popup.floats![0]!.leaf.id;
  const chassisZ = Number(document.querySelector<HTMLElement>(`[data-island="${leafId}"]`)!.style.zIndex);
  assert.equal(Number(frame.style.zIndex), chassisZ + 2, 'above the content, painted at chassis + 1');
  const west = document.querySelector<HTMLElement>('[data-island-float-resize-handle="w"]')!;
  assert.match(west.className, /cursor-ew-resize/);
  assert.match(document.querySelector<HTMLElement>('[data-island-float-resize-handle="ne"]')!.className, /cursor-nesw-resize/);
  await w.act(() => { west.dispatchEvent(pointer('pointerdown', 300, 400)); });
  await w.act(() => { west.dispatchEvent(pointer('pointermove', 180, 400)); });
  assert.equal(w.calls.at(-1)!.persist, false);
  await w.act(() => { west.dispatchEvent(pointer('pointerup', 180, 400)); });
  const rect = w.calls.at(-1)!.tree.floats![0]!.rect;
  assert.equal(w.calls.at(-1)!.persist, true);
  assert.ok(Math.abs(rect.x - 0.15) < 1e-6 && Math.abs(rect.x + rect.width - 0.75) < 1e-6, 'the right side stayed');
  assert.ok(Math.abs(rect.height - 0.5) < 1e-6);
});

test('a popup pressed into a bottom corner stacks under that column; the middle of the edge spans the workspace', async (t) => {
  const w = await mount(t);
  const drag = await import('@/lib/island-drag');
  t.after(() => drag.resetIslandDragForTests());
  const base = w.tree.defaultIslandTree();
  const split = w.tree.insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'term' } }).tree;
  const termId = w.tree.collectLeaves(split.root)[1]!.id;
  await w.render(w.tree.openFloat(split, { type: FAKE, params: { id: 'web' } }, { x: 0.3, y: 0.3, width: 0.4, height: 0.4 }).tree, true);
  const handle = Array.from(document.querySelectorAll<HTMLElement>('[data-island-tab-handle]')).at(-1)!;
  const bottom = window.innerHeight - 2;
  await w.act(() => { handle.dispatchEvent(pointer('pointerdown', 500, 260)); });
  await w.act(() => { window.dispatchEvent(pointer('pointermove', 600, bottom)); });
  assert.equal(document.querySelector<HTMLElement>('[data-island-drop-preview]')!.dataset.islandDropPreview, 'root:bottom');
  await w.act(() => { window.dispatchEvent(pointer('pointermove', 1195, bottom)); });
  assert.equal(document.querySelector<HTMLElement>('[data-island-drop-preview]')!.dataset.islandDropPreview, 'bottom', 'a corner: the column, not the page');
  await w.act(() => { window.dispatchEvent(pointer('pointerup', 1195, bottom)); });
  const after = w.calls.at(-1)!.tree;
  assert.equal(after.floats?.length ?? 0, 0);
  assert.equal(after.root.kind === 'split' ? after.root.dir : '', 'row', 'still two columns');
  const right = after.root.kind === 'split' ? after.root.children[1]! : after.root;
  assert.equal(right.kind === 'split' ? right.dir : '', 'column', 'the right column is stacked');
  const stacked = right.kind === 'split' ? right.children.map((c) => (c.kind === 'leaf' ? c.id : '')) : [];
  assert.equal(stacked[0], termId, 'under the terminal');
});

test('the route\'s island moves as an outline: only an edge moves it', async (t) => {
  const w = await mount(t);
  const drag = await import('@/lib/island-drag');
  t.after(() => drag.resetIslandDragForTests());
  const base = w.tree.defaultIslandTree();
  await w.render(w.tree.insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'a' } }).tree, true);
  const page = Array.from(document.querySelectorAll<HTMLElement>('[data-island-tab-handle]')).find((h) => h.textContent?.includes('Kanban'))!;
  await w.act(() => { page.dispatchEvent(pointer('pointerdown', 100, 16)); });
  const before = w.calls.length;
  await w.act(() => { window.dispatchEvent(pointer('pointermove', 500, 400)); });
  assert.equal(w.calls.length, before, 'never a popup');
  assert.ok(document.querySelector('[data-island-window-outline]'));
  await w.act(() => { window.dispatchEvent(pointer('pointerup', 500, 400)); });
  assert.equal(w.calls.length, before, 'released in mid-page: nothing changes');
  await w.act(() => { page.dispatchEvent(pointer('pointerdown', 100, 16)); });
  await w.act(() => { window.dispatchEvent(pointer('pointermove', 1199, 400)); });
  assert.equal(document.querySelector<HTMLElement>('[data-island-drop-preview]')!.dataset.islandDropPreview, 'root:right');
  await w.act(() => { window.dispatchEvent(pointer('pointerup', 1199, 400)); });
  const leaves = w.tree.collectLeaves(w.calls.at(-1)!.tree.root);
  assert.equal(leaves.at(-1)!.tabs[0]!.content.type, 'host:route', 'the page went to the right');
});

test('a content dragged from outside onto the single page frame opens beside it; an unknown one is refused', async (t) => {
  const w = await mount(t);
  const drag = await import('@/lib/island-drag');
  t.after(() => drag.resetIslandDragForTests());
  // The page frame needs a size on screen; jsdom lays nothing out.
  const proto = window.HTMLElement.prototype;
  Object.defineProperty(proto, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800, x: 0, y: 0 }),
    configurable: true,
  });
  t.after(() => { Reflect.deleteProperty(proto, 'getBoundingClientRect'); });
  await w.render(w.tree.defaultIslandTree(), true);
  const unknown = fakeTransfer();
  await w.act(async () => { drag.startIslandDrag({ dataTransfer: unknown as unknown as DataTransfer }, { type: 'acme:nope', params: {} }); await tick(); });
  let layer = document.querySelector<HTMLElement>('[data-island-drop-layer]')!;
  assert.ok(layer, 'raised over the page frame, though nothing is painted');
  assert.equal(layer.parentElement, document.body, 'portalled: the frame may have no box of its own');
  await w.act(() => { layer.dispatchEvent(dragEvent('dragover', unknown, 1150, 400)); });
  assert.equal(document.querySelector('[data-island-drop-label]')!.textContent, 'This content cannot open in the workspace');
  await w.act(async () => { drag.endIslandDrag(); });

  const dt = fakeTransfer();
  let dropped = 0;
  await w.act(async () => {
    drag.startIslandDrag({ dataTransfer: dt as unknown as DataTransfer }, { type: FAKE, params: { id: 'z' } }, { onDropped: () => { dropped += 1; } });
    await tick();
  });
  layer = document.querySelector<HTMLElement>('[data-island-drop-layer]')!;
  await w.act(() => { layer.dispatchEvent(dragEvent('dragover', dt, 1150, 400)); });
  assert.equal(document.querySelector<HTMLElement>('[data-island-drop-preview]')!.dataset.islandDropPreview, 'right');
  await w.act(() => { layer.dispatchEvent(dragEvent('drop', dt, 1150, 400)); });
  assert.equal(w.workspace().dataset.islandWorkspace, 'split');
  assert.ok(document.querySelector('[data-board="z"]'));
  assert.equal(dropped, 1, 'the source hears that its content was taken');
});

test('a tab dropped on the tab bar of another island joins it at the place under the pointer', async (t) => {
  const w = await mount(t);
  const drag = await import('@/lib/island-drag');
  t.after(() => drag.resetIslandDragForTests());
  const base = w.tree.defaultIslandTree();
  const split = w.tree.insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'a' } }).tree;
  const right = w.tree.collectLeaves(split.root)[1]!.id;
  await w.render(w.tree.addTab(split, right, { type: FAKE, params: { id: 'b' } }).tree, true);
  const tabB = Array.from(document.querySelectorAll<HTMLElement>('[data-island-tab-handle]')).find((h) => h.textContent?.includes('Board') && h.getAttribute('draggable') === 'true' && h.querySelector('[aria-selected="true"]'))!;
  const dt = fakeTransfer();
  await w.act(async () => { tabB.dispatchEvent(dragEvent('dragstart', dt)); await tick(); });
  const layer = document.querySelector<HTMLElement>('[data-island-drop-layer]')!;
  // Over the page's header (y < 32): a tab, never an edge.
  await w.act(() => { layer.dispatchEvent(dragEvent('dragover', dt, 300, 16)); });
  assert.equal(document.querySelector<HTMLElement>('[data-island-drop-preview]')!.dataset.islandDropPreview, 'center');
  assert.equal(document.querySelector('[data-island-drop-label]')!.textContent, 'Add a tab to Kanban');
  await w.act(() => { layer.dispatchEvent(dragEvent('drop', dt, 300, 16)); });
  const leaves = w.tree.collectLeaves(w.calls.at(-1)!.tree.root);
  assert.equal(leaves.length, 2);
  assert.equal(leaves[0]!.tabs.length, 2, 'the page island now holds the tab');
  assert.equal(leaves[1]!.tabs.length, 1);
});

test('below 768 px nothing is draggable and no layer rises', async (t) => {
  const w = await mount(t, { width: 600 });
  const drag = await import('@/lib/island-drag');
  t.after(() => drag.resetIslandDragForTests());
  const base = w.tree.defaultIslandTree();
  await w.render(w.tree.insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'a' } }).tree, true);
  assert.ok(!document.querySelector('[draggable="true"]'));
  const dt = fakeTransfer();
  await w.act(async () => { drag.startIslandDrag({ dataTransfer: dt as unknown as DataTransfer }, { type: FAKE, params: { id: 'z' } }); await tick(); });
  assert.ok(!document.querySelector('[data-island-drop-layer]'));
});

test('useIslandDragSource: draggable only while a workspace is announced and wide, and its drag is ours', async (t) => {
  const w = await mount(t);
  const drag = await import('@/lib/island-drag');
  t.after(() => drag.resetIslandDragForTests());
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const content = { type: FAKE, params: { id: 's' } };
  function Source() {
    const props = drag.useIslandDragSource(content, { label: 'Source' });
    return React.createElement('div', { id: 'source', ...props }, 'source');
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await w.act(() => { root.render(React.createElement(Source)); });
  const source = () => document.getElementById('source')!;
  assert.equal(source().getAttribute('draggable'), 'false', 'no workspace announced');
  const handle = { open: () => true, activate: () => {}, close: () => {} };
  const withdraw = w.bus.announceIslandWorkspace(handle);
  t.after(withdraw);
  await w.act(() => { w.bus.publishIslandTabs(handle, [], false); });
  assert.equal(source().getAttribute('draggable'), 'true');
  const dt = fakeTransfer();
  dt.effectAllowed = 'copyMove';
  source().dispatchEvent(dragEvent('dragstart', dt));
  assert.equal(dt.effectAllowed, 'copyMove', 'what the source allowed is kept');
  const ours = drag.readIslandDrop(dt as unknown as DataTransfer);
  assert.deepEqual(ours?.source, { kind: 'content', content });
  assert.equal(ours?.label, 'Source');
  drag.endIslandDrag();
  await w.act(() => { w.bus.publishIslandTabs(handle, [], true); });
  assert.equal(source().getAttribute('draggable'), 'false', 'below 768 px');
  await w.act(() => root.unmount());
});

// ---------------------------------------------------------------- keyboard (§11)

const key = (target: EventTarget, k: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const announced = () => document.querySelector('[aria-live="polite"]')?.textContent ?? '';

test('a tab bar follows the ARIA tabs pattern: arrows show and focus, Delete closes and says so', async (t) => {
  const w = await mount(t);
  const base = w.tree.defaultIslandTree();
  let tree = w.tree.addTab(base, base.root.id, { type: FAKE, params: { id: 'a' } }).tree;
  tree = w.tree.addTab(tree, base.root.id, { type: FAKE, params: { id: 'b' } }).tree;
  await w.render(w.tree.activateTab(tree, w.tree.collectLeaves(tree.root)[0]!.tabs[0]!.id).tree);
  const tabs = () => Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'));
  assert.equal(tabs().length, 3);
  assert.deepEqual(tabs().map((x) => x.tabIndex), [0, -1, -1], 'roving focus: only the shown tab is in the Tab order');
  tabs()[0]!.focus();
  await w.act(() => { key(tabs()[0]!, 'ArrowRight'); });
  assert.equal(tabs()[1]!.getAttribute('aria-selected'), 'true');
  assert.equal(document.activeElement, tabs()[1], 'the focus follows');
  await w.act(() => { key(tabs()[1]!, 'End'); });
  assert.equal(tabs()[2]!.getAttribute('aria-selected'), 'true');
  await w.act(() => { key(tabs()[2]!, 'Delete'); });
  assert.equal(tabs().length, 2, 'closed');
  assert.equal(announced(), 'Board closed');
  assert.ok(document.activeElement?.getAttribute('role') === 'tab', 'the focus stays in the bar');
  await w.act(() => { key(tabs()[0]!, 'Home'); });
  await w.act(() => { key(tabs()[0]!, 'Delete'); });
  assert.equal(tabs().length, 2, 'the page of the view does not close');
});

test('F6 moves the focus from island to island, Shift+F6 back', async (t) => {
  const w = await mount(t);
  const base = w.tree.defaultIslandTree();
  const split = w.tree.insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'a' } }).tree;
  const [left, right] = w.tree.collectLeaves(split.root);
  await w.render(w.tree.focusLeaf(split, left!.id).tree);
  await w.act(() => { key(document.body, 'F6'); });
  assert.equal(w.calls.at(-1)!.tree.focus, right!.id);
  assert.equal(document.activeElement?.closest('[data-island]')?.getAttribute('data-island'), right!.id, 'the focus is in its header');
  await w.act(() => { key(document.activeElement!, 'F6', { shiftKey: true }); });
  assert.equal(w.calls.at(-1)!.tree.focus, left!.id);
  const before = w.calls.length;
  await w.act(() => { key(document.body, 'F6', { ctrlKey: true }); });
  assert.equal(w.calls.length, before, 'Ctrl+F6 is not ours');
});

test('"Move…" from a tab\'s M key: arrows and Tab pick the place, the preview follows, Enter drops, Escape cancels', async (t) => {
  const w = await mount(t);
  const base = w.tree.defaultIslandTree();
  await w.render(w.tree.insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'a' } }).tree, true);
  const board = () => Array.from(document.querySelectorAll<HTMLElement>('[data-island-tab-handle]')).find((h) => h.textContent?.includes('Board'))!;
  const openMove = async () => {
    // Alone in its island, the title itself is the handle that takes the key.
    const tab = board().querySelector<HTMLElement>('[role="tab"]') ?? board();
    assert.equal(tab.getAttribute('aria-keyshortcuts'), 'M Shift+M', 'the key is announced');
    await w.act(() => { key(tab, 'm'); });
  };
  await openMove();
  assert.ok(document.querySelector('[data-island-move-layer]'));
  assert.match(announced(), /^Moving Board\./);
  // Starts on the other island, centre.
  assert.equal(document.querySelector<HTMLElement>('[data-island-drop-preview]')!.dataset.islandDropPreview, 'center');
  assert.equal(document.querySelector('[data-island-drop-label]')!.textContent, 'Add a tab to Kanban');
  await w.act(() => { key(document.body, 'Tab'); });
  await w.act(() => { key(document.body, 'Tab'); });
  assert.equal(document.querySelector<HTMLElement>('[data-island-drop-preview]')!.dataset.islandDropPreview, 'bottom');
  assert.equal(announced(), 'Stack below Kanban');
  await w.act(() => { key(document.body, 'Escape'); });
  assert.ok(!document.querySelector('[data-island-move-layer]'), 'cancelled');
  assert.equal(announced(), 'Move cancelled');
  assert.equal(w.calls.length, 0, 'nothing written');

  await openMove();
  await w.act(() => { key(document.body, 'Tab'); });
  await w.act(() => { key(document.body, 'Tab'); });
  await w.act(() => { key(document.body, 'Enter'); });
  const after = w.calls.at(-1)!.tree;
  assert.equal(after.root.kind === 'split' ? after.root.dir : '', 'column', 'stacked under the page');
  assert.equal(announced(), 'Board opened below Kanban');
  assert.ok(!document.querySelector('[data-island-move-layer]'));
  assert.equal(w.mounts.filter((m) => m === 'a').length, 1, 'moved, not remounted');
});

test('the route reads the size of its island while painted, nothing while alone', async (t) => {
  const w = await mount(t);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { IslandWorkspaceView, useIslandRouteSize } = await import('./island-workspace');
  const sizes: (string | null)[] = [];
  function Probe() {
    const size = useIslandRouteSize();
    sizes.push(size ? `${size.width}x${size.height}` : null);
    return null;
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const base = w.tree.defaultIslandTree();
  const view = (tree: IslandTree) => React.createElement(IslandWorkspaceView, { tree, onTree: () => {}, route: React.createElement(Probe) });
  await w.act(() => { root.render(view(base)); });
  assert.equal(sizes.at(-1), null, 'alone: the page reads the window, as before');
  await w.act(() => { root.render(view(w.tree.insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'a' } }).tree)); });
  // 1200 × 800, gap 8: two columns of 596, under a 32 px header.
  assert.equal(sizes.at(-1), '596x768');
  await w.act(() => root.unmount());
});

test('sameIslandIdentity: one param, several params, or all of them', async () => {
  const { sameIslandIdentity } = await import('./island-workspace');
  assert.equal(sameIslandIdentity('id', { id: 'a', x: 1 }, { id: 'a', x: 2 }), true);
  assert.equal(sameIslandIdentity('id', { x: 1 }, { x: 1 }), false, 'a missing key never matches');
  const file = ['agentId', 'path'] as const;
  assert.equal(sameIslandIdentity(file, { agentId: 'a', path: 'x.md', mode: 'edit' }, { agentId: 'a', path: 'x.md', mode: 'preview' }), true);
  assert.equal(sameIslandIdentity(file, { agentId: 'a', path: 'x.md' }, { agentId: 'b', path: 'x.md' }), false);
  assert.equal(sameIslandIdentity(undefined, { id: 'a' }, { id: 'a' }), true);
  assert.equal(sameIslandIdentity(undefined, { id: 'a' }, { id: 'a', x: 1 }), false);
  assert.equal(sameIslandIdentity([], { id: 'a' }, { id: 'a' }), false);
});

test('one primary instance per exclusive group: the focused one, sticky, the route enrolled (Q10)', async (t) => {
  const w = await mount(t, { exclusive: true });
  const base = w.tree.defaultIslandTree();
  await w.render(base);
  const primaryOf = (sel: string) => document.querySelector<HTMLElement>(sel)?.dataset.primary;
  assert.equal(primaryOf('#route'), 'true', 'alone, the page is the instance');

  // What is opened takes the focus, hence the group.
  const one = w.tree.insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'a' } }).tree;
  await w.set(one);
  assert.equal(primaryOf('[data-board="a"]'), 'true');
  assert.equal(primaryOf('#route'), 'false', 'the other one shows a stand-in');
  assert.equal(document.getElementById('route')!.dataset.focused, 'false', 'push-to-talk follows the focus');

  // Clicking into an island makes it active, and its content primary — on
  // the click: a press alone changes nothing, so what it lands on stays put.
  await w.act(() => { document.getElementById('route')!.dispatchEvent(new window.Event('pointerdown', { bubbles: true })); });
  assert.equal(primaryOf('#route'), 'false', 'pressed, not released: the layout does not move under the pointer');
  await w.act(() => { document.getElementById('route')!.dispatchEvent(new window.Event('pointerup', { bubbles: true })); });
  assert.equal(primaryOf('#route'), 'false', 'released: still nothing until the click');
  await w.act(() => { document.getElementById('route')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  assert.equal(primaryOf('#route'), 'true');
  assert.equal(document.getElementById('route')!.dataset.focused, 'true');
  assert.equal(primaryOf('[data-board="a"]'), 'false');
  const island = document.querySelector<HTMLElement>('[data-board="a"]')!.closest<HTMLElement>('[data-island-tab]')!;
  await w.act(() => { island.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  assert.equal(primaryOf('[data-board="a"]'), 'true');
  assert.equal(primaryOf('#route'), 'false');

  // Back on the page's island, the page takes it again.
  const focused = w.calls.at(-1)!.tree;
  const leaves = w.tree.collectLeaves(focused.root);
  const onPage = w.tree.focusLeaf(focused, leaves[0]!.id).tree;
  await w.set(onPage);
  assert.equal(primaryOf('#route'), 'true');
  // An inactive tab is unmounted, so it never holds the group.
  const tabbed = w.tree.addTab(onPage, leaves[1]!.id, { type: FAKE, params: { id: 'b' } }).tree;
  await w.set(tabbed);
  assert.ok(!document.querySelector('[data-board="a"]'), 'the inactive tab is unmounted (Q12)');
  assert.equal(document.querySelectorAll('[data-primary="true"]').length, 1, 'exactly one primary');
});

test('focus on an island of another kind keeps the previous primary', async (t) => {
  const w = await mount(t, { exclusive: true });
  const base = w.tree.defaultIslandTree();
  await w.render(base);
  const one = w.tree.insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'a' } }).tree;
  const leafOfA = w.tree.collectLeaves(one.root)[1]!.id;
  const focusedA = w.tree.focusLeaf(one, leafOfA).tree;
  // A content no group claims, in a third island, takes the focus.
  const third = w.tree.insertAt(focusedA, leafOfA, 'bottom', { type: 'fixture:missing', params: {} }).tree;
  const leafOfMissing = w.tree.collectLeaves(third.root).find((l) => l.tabs[0]!.content.type === 'fixture:missing')!.id;
  await w.set(focusedA);
  await w.set(w.tree.focusLeaf(third, leafOfMissing).tree);
  assert.equal(document.querySelector<HTMLElement>('[data-board="a"]')!.dataset.primary, 'true');
  assert.equal(document.querySelector<HTMLElement>('#route')!.dataset.primary, 'false');
});

test('opening a grid through the bus validates every cell and keeps the route and neighbouring content mounted', async (t) => {
  const w = await mount(t);
  const content = (id: string) => ({ type: FAKE, params: { id } });
  assert.equal(w.bus.openGridInIsland({ cols: 2, rows: 1 }, [content('a'), content('b')]), false);
  const base = w.tree.defaultIslandTree();
  await w.render(w.tree.insertAt(base, base.root.id, 'right', content('neighbour')).tree, true);
  const page = document.getElementById('route');
  const neighbour = document.querySelector('[data-board="neighbour"]');
  const before = w.calls.length;
  let accepted = true;
  await w.act(() => { accepted = w.bus.openGridInIsland({ cols: 2, rows: 1 }, [content('a'), { type: FAKE, params: {} }]); });
  assert.equal(accepted, false, 'parseParams rejects one cell, none open');
  assert.equal(w.calls.length, before);
  await w.act(() => { accepted = w.bus.openGridInIsland({ cols: 2, rows: 2 }, [content('a'), content('b'), null, content('c')]); });
  assert.equal(accepted, true);
  assert.equal(w.calls.length, before + 1, 'one atomic update, persisted once');
  assert.equal(w.calls.at(-1)!.persist, true);
  assert.equal(document.getElementById('route'), page);
  assert.equal(document.querySelector('[data-board="neighbour"]'), neighbour);
  assert.equal(document.querySelectorAll('[data-board]').length, 4);
  assert.deepEqual(w.mounts, ['neighbour', 'a', 'b', 'c']);
  const last = w.calls.at(-1)!.tree;
  await w.act(() => { accepted = w.bus.openGridInIsland({ cols: 4, rows: 2 }, 'defghijk'.split('').map(content)); });
  assert.equal(accepted, false, 'the combined island limit refuses the entire grid');
  assert.equal(w.calls.at(-1)!.tree, last);
});

test('a popup closes from its own cross; its menu no longer offers "Move…"', async (t) => {
  const w = await mount(t);
  const base = w.tree.defaultIslandTree();
  const popup = w.tree.openFloat(base, { type: FAKE, params: { id: 'p' } }, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }).tree;
  await w.render(popup, true);
  const leafId = popup.floats![0]!.leaf.id;
  const chassis = document.querySelector<HTMLElement>(`[data-island="${leafId}"]`)!;
  const cross = chassis.querySelector<HTMLElement>('[data-island-close]');
  assert.ok(cross, 'a window cross');
  assert.equal(cross!.parentElement!.lastElementChild, cross, 'at the right end');
  const handle = chassis.querySelector<HTMLElement>('[data-island-tab-handle]')!;
  await w.act(() => { handle.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
  assert.ok(document.querySelector('[data-island-menu="dock"]'));
  assert.ok(!document.querySelector('[data-island-menu="move-tab"]') && !document.querySelector('[data-island-menu="move-island"]'));
  await w.act(() => { key(document.activeElement ?? document.body, 'Escape'); });
  await w.act(() => { cross!.click(); });
  assert.equal(w.calls.at(-1)!.tree.floats?.length ?? 0, 0, 'the popup is gone');
});

test('setParams reaches a tab in a popup, and says so when a change cannot land (TIM-0127)', async (t) => {
  const w = await mount(t);
  const popup = w.tree.openFloat(w.tree.defaultIslandTree(), { type: FAKE, params: { id: 'p' } }, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }).tree;
  await w.render(popup, true);
  const warn = t.mock.method(console, 'warn', () => {});
  await w.act(() => { w.setters.get('p')!({ id: 'q' }); });
  assert.equal(w.calls.at(-1)!.tree.floats?.[0]!.leaf.tabs[0]!.content.params.id, 'q', 'the popup tab took the new params');
  assert.equal(warn.mock.callCount(), 0);
  const before = w.calls.length;
  await w.act(() => { w.setters.get('q')!({ id: 42 }); });
  assert.equal(w.calls.length, before, 'refused params change nothing');
  assert.equal(warn.mock.callCount(), 1, 'but they are reported');
  assert.match(String(warn.mock.calls[0]!.arguments[0]), /setParams not applied/);
});

test('a popup folds into a tab in the corner from its header or its menu, and comes back where it was, on top', async (t) => {
  const w = await mount(t);
  const base = w.tree.defaultIslandTree();
  const first = w.tree.openFloat(base, { type: FAKE, params: { id: 'p' } }, { x: 0.1, y: 0.1, width: 0.4, height: 0.4 }).tree;
  const leafId = first.focus!;
  const both = w.tree.openFloat(first, { type: FAKE, params: { id: 'q' } }, { x: 0.5, y: 0.5, width: 0.3, height: 0.3 }).tree;
  const otherId = both.focus!;
  await w.render(both, true);
  const chassis = document.querySelector<HTMLElement>(`[data-island="${leafId}"]`)!;
  const fold = chassis.querySelector<HTMLButtonElement>('[data-island-minimize]');
  assert.ok(fold, 'a minimize button in the header');
  assert.equal(fold!.getAttribute('aria-label'), 'Minimize');
  assert.equal(fold!.nextElementSibling, chassis.querySelector('[data-island-close]'), 'beside the cross, the cross last');
  await w.act(() => { fold!.click(); });
  const folded = w.calls.at(-1)!.tree;
  assert.equal(w.tree.floatOf(folded, leafId)?.minimized, true);
  assert.deepEqual(w.tree.floatOf(folded, leafId)?.rect, { x: 0.1, y: 0.1, width: 0.4, height: 0.4 });
  assert.ok(!document.querySelector(`[data-island="${leafId}"]`), 'off the scene');
  assert.ok(!document.querySelector('[data-board="p"]'), 'its content is not shown');
  assert.ok(document.querySelector('[data-board="q"]'), 'the other popup stays');
  const pill = document.querySelector<HTMLButtonElement>(`[data-island-minimized="${leafId}"]`);
  assert.ok(pill, 'a tab in the corner');
  assert.equal(pill!.closest('[data-island-workspace]'), null, 'carried out of the isolated workspace');
  assert.match(pill!.parentElement!.className, /fixed bottom-4 right-4/);
  assert.equal(pill!.getAttribute('aria-label'), 'Show Board again');
  assert.equal(pill!.type, 'button');
  assert.equal(document.activeElement, pill, 'the focus follows the popup to its tab');
  await w.act(() => { pill!.click(); });
  const back = w.calls.at(-1)!.tree;
  assert.equal(w.tree.floatOf(back, leafId)?.minimized, undefined);
  assert.equal(back.focus, leafId);
  assert.ok(!document.querySelector('[data-island-minimized]'), 'no tab left in the corner');
  const z = (id: string) => Number(document.querySelector<HTMLElement>(`[data-island="${id}"]`)!.style.zIndex);
  assert.ok(z(leafId) > z(otherId), 'back on top of the other popup');
  assert.equal(document.querySelector<HTMLElement>(`[data-island="${leafId}"]`)!.style.left, `${0.1 * 1200}px`, 'at the same place');
  assert.ok(document.activeElement?.closest(`[data-island="${leafId}"]`), 'the focus is back in the popup');
  // The menu offers the same gesture.
  const handle = document.querySelector<HTMLElement>(`[data-island="${leafId}"] [data-island-tab-handle]`)!;
  await w.act(() => { handle.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
  const item = document.querySelector<HTMLElement>('[data-island-menu="minimize"]');
  assert.ok(item, 'a "Minimize" entry in its menu');
  await w.act(() => { item!.click(); });
  assert.equal(w.tree.floatOf(w.calls.at(-1)!.tree, leafId)?.minimized, true);
});

test('the page alone with only folded popups is painted as it always was, their tabs in the corner', async (t) => {
  const w = await mount(t);
  const base = w.tree.defaultIslandTree();
  const popup = w.tree.openFloat(base, { type: FAKE, params: { id: 'p' } }, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }).tree;
  const leafId = popup.focus!;
  const folded = w.tree.setFloatMinimized(popup, leafId, true).tree;
  await w.render(folded, true);
  const ws = w.workspace();
  assert.equal(ws.dataset.islandWorkspace, 'single');
  assert.equal(ws.className, 'rooks-island flex min-h-0 flex-1 flex-col', 'the frame the page always had');
  assert.ok(document.getElementById('route'));
  assert.ok(!document.querySelector('[data-board="p"]'));
  const pill = document.querySelector<HTMLButtonElement>(`[data-island-minimized="${leafId}"]`)!;
  assert.ok(pill);
  await w.act(() => { pill.click(); });
  assert.equal(w.workspace().dataset.islandWorkspace, 'split');
  assert.ok(document.querySelector('[data-board="p"]'));
});

test('a kept-mounted content of a folded popup stays alive, hidden from the page, and is not remounted', async (t) => {
  const w = await mount(t, { keepMounted: true });
  const base = w.tree.defaultIslandTree();
  const popup = w.tree.openFloat(base, { type: FAKE, params: { id: 'live' } }, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }).tree;
  const leafId = popup.focus!;
  await w.render(popup, true);
  const mounted = w.mounts.length;
  await w.act(() => { document.querySelector<HTMLButtonElement>('[data-island-minimize]')!.click(); });
  assert.equal(w.workspace().dataset.islandWorkspace, 'single', 'the page alone on screen');
  const board = document.querySelector<HTMLElement>('[data-board="live"]');
  assert.ok(board, 'still mounted');
  const wrapper = board!.closest<HTMLElement>('[data-island-tab]')!;
  assert.equal(wrapper.className, 'hidden', 'not laid out in the page');
  assert.equal(wrapper.getAttribute('inert'), '');
  assert.equal(board!.dataset.active, 'false');
  await w.act(() => { document.querySelector<HTMLButtonElement>(`[data-island-minimized="${leafId}"]`)!.click(); });
  assert.equal(document.querySelector<HTMLElement>('[data-board="live"]'), board, 'the same node');
  assert.equal(w.mounts.length, mounted, 'not remounted');
  assert.equal(board!.dataset.active, 'true');
});

test('a folded popup is stored folded, and a pinned one stays folded on the next view', async (t) => {
  const s = await mountStored(t, 'owner-fold', ({ islands, pinned }) => {
    const base = defaultIslandTree();
    const own = openFloat(base, { type: FAKE, params: { id: 'own' } }, { x: 0.1, y: 0.1, width: 0.4, height: 0.4 }).tree;
    const kept = openFloat(defaultIslandTree(), { type: FAKE, params: { id: 'kept' } }, { x: 0.5, y: 0.1, width: 0.4, height: 0.4 }).tree;
    const keptFolded = setFloatMinimized(setFloatPinned(kept, kept.focus!, true).tree, kept.focus!, true).tree;
    return [[islands, own], [pinned, { v: 1, floats: keptFolded.floats }]];
  });
  try {
    assert.ok(!s.host.querySelector('[data-board="kept"]'), 'the pinned popup arrives folded');
    assert.ok(document.querySelector('[data-island-minimized]'), 'as a tab in the corner');
    const fold = s.host.querySelector<HTMLButtonElement>('[data-island-float] [data-island-minimize]')!;
    const viewPuts = () => s.writes.filter((r) => r.scope === s.scopes.islands && r.method === 'PUT');
    await s.w.act(() => { fold.click(); });
    await s.until(() => viewPuts().length > 0 && document.querySelectorAll('[data-island-minimized]').length === 2, 'the folded popup to be stored');
    const put = viewPuts().at(-1);
    assert.ok(put, 'the view is written, not erased');
    assert.equal((put!.layout as IslandTree).floats?.[0]?.minimized, true);
    assert.equal(document.querySelectorAll('[data-island-minimized]').length, 2);
    const keptId = (s.rows.get(s.scopes.pinned) as IslandTree).floats![0]!.leaf.id;
    const kept = document.querySelector<HTMLButtonElement>(`[data-island-minimized="${keptId}"]`)!;
    await s.w.act(() => { kept.click(); });
    await s.until(() => !!s.host.querySelector('[data-board="kept"]') && s.writes.some((r) => r.scope === s.scopes.pinned && r.method === 'PUT'), 'the pinned popup to unfold and be stored');
    assert.ok(s.host.querySelector('[data-board="kept"]'), 'shown again');
    const pinnedPut = s.writes.filter((r) => r.scope === s.scopes.pinned && r.method === 'PUT').at(-1);
    assert.ok(pinnedPut, 'the account\'s pinned row is written');
    const pinnedFloat = (pinnedPut!.layout as { floats: { minimized?: boolean; pinned?: boolean }[] }).floats[0]!;
    assert.equal(pinnedFloat.minimized, undefined, 'no longer folded');
    assert.equal(pinnedFloat.pinned, true);
    assert.equal(s.toasts(), 0);
  } finally { await s.close(); }
});

test('every island but the page\'s has a close and a minimize; the page\'s island has neither', async (t) => {
  const s = await mountStored(t, 'owner-header-buttons', ({ islands }) => {
    const base = defaultIslandTree();
    return [[islands, insertAt(base, base.root.id, 'right', { type: FAKE, params: { id: 'chat' } }).tree]];
  });
  try {
    const chassis = Array.from(s.host.querySelectorAll<HTMLElement>('[data-island]'));
    assert.equal(chassis.length, 2);
    const withButtons = chassis.filter((c) => c.querySelector('[data-island-close]') && c.querySelector('[data-island-minimize]'));
    const without = chassis.filter((c) => !c.querySelector('[data-island-close]') && !c.querySelector('[data-island-minimize]'));
    assert.equal(withButtons.length, 1, 'the docked board can fold and close');
    assert.equal(without.length, 1, 'the page\'s island can do neither');
    // A board opens on its picto; the page's island wears none (no agent in this URL).
    assert.ok(withButtons[0]!.querySelector('[data-island-tab-handle] svg, [data-island-tab-handle] span[aria-hidden]'), 'a picto at the left of the title');
    assert.ok(!without[0]!.querySelector('[data-island-tab-handle] svg'), 'the page has no picto');

    await s.w.act(() => { withButtons[0]!.querySelector<HTMLButtonElement>('[data-island-minimize]')!.click(); });
    await s.until(() => !!s.host.ownerDocument.querySelector('[data-island-minimized]'), 'the docked island to fold');
    assert.ok(s.host.ownerDocument.querySelector('[data-island-minimized]'), 'the docked island folded into the corner');
  } finally { await s.close(); }
});

// ------------------------------------------------------- beforeClose (TIM-0128)

test('beforeClose: a type keeps a tab the user asked to close, synchronously or after asking', async (t) => {
  const asked: string[] = [];
  let answer: boolean | Promise<boolean> = false;
  const w = await mount(t, { beforeClose: (params, tabId) => { asked.push(`${String(params.id)}:${tabId.length > 0}`); return answer; } });
  const base = w.tree.defaultIslandTree();
  let tree = w.tree.addTab(base, base.root.id, { type: FAKE, params: { id: 'a' } }).tree;
  tree = w.tree.addTab(tree, base.root.id, { type: FAKE, params: { id: 'b' } }).tree;
  await w.render(tree);
  const tabs = () => Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'));
  assert.equal(tabs().length, 3);

  await w.act(() => { key(tabs()[2]!, 'Delete'); });
  assert.deepEqual(asked, ['b:true'], 'asked with the tab\'s params and id');
  assert.equal(tabs().length, 3, 'false keeps the tab');

  let settle: (ok: boolean) => void = () => {};
  answer = new Promise<boolean>((r) => { settle = r; });
  await w.act(() => { key(tabs()[2]!, 'Delete'); });
  assert.equal(tabs().length, 3, 'nothing closes while the type is still asking');
  await w.act(() => { key(tabs()[2]!, 'Delete'); });
  assert.equal(asked.length, 2, 'a second request for the same tab does not ask twice');
  await w.act(async () => { settle(true); await answer; });
  await waitUntil(w.act, () => tabs().length === 2, 'closed once the type agreed');
  assert.equal(announced(), 'Board closed');

  answer = true;
  await w.act(() => { key(tabs()[1]!, 'Delete'); });
  assert.equal(tabs().length, 0, 'a plain true closes at once: the page is alone again');
});

test('a recall releases the tabs it replaces: asked first, closed once written, the kept ones untouched', async (t) => {
  const keep = new Set<string>();
  const asked: string[] = [];
  const closed: string[] = [];
  const w = await mount(t, {
    viewKey: 'v2.view',
    beforeClose: (params) => { asked.push(String(params.id)); return !keep.has(String(params.id)); },
    onClose: (params) => { closed.push(String(params.id)); },
  });
  const rect = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
  const base = w.tree.defaultIslandTree();
  let tree = w.tree.addTab(base, base.root.id, { type: FAKE, params: { id: 'a' } }).tree;
  tree = w.tree.addTab(tree, base.root.id, { type: FAKE, params: { id: 'b' } }).tree;
  tree = w.tree.openFloat(tree, { type: FAKE, params: { id: 'c' } }, rect).tree;
  tree = w.tree.openFloat(tree, { type: FAKE, params: { id: 'd' } }, rect).tree;
  tree = w.tree.setFloatPinned(tree, tree.floats![1]!.leaf.id, true).tree;
  await w.render(tree, true);
  // The arrangement lays `a` back under another tab id: same content, kept.
  const blank = w.tree.defaultIslandTree();
  const next = w.tree.addTab(blank, blank.root.id, { type: FAKE, params: { id: 'a' } }).tree;

  assert.ok(await w.bus.releaseIslandTabs('v2.other', next), 'another view: nothing to ask');
  assert.deepEqual(asked, []);

  keep.add('c');
  assert.equal(await w.bus.releaseIslandTabs('v2.view', next), null, 'a tab that asks to stay cancels the recall');
  assert.deepEqual(asked, ['b', 'c'], 'only the tabs leaving are asked: not a (kept), not the pinned d, not the page');
  assert.deepEqual(closed, []);

  keep.clear();
  const release = await w.bus.releaseIslandTabs('v2.view', next);
  assert.ok(release);
  assert.deepEqual(closed, [], 'nothing closes before the write went through');
  release();
  assert.deepEqual(closed, ['b', 'c'], 'a replaced terminal would end its shell here');
});

test('beforeClose: closing an island keeps every tab when one of them is kept', async (t) => {
  const keep = new Set(['b']);
  const asked: string[] = [];
  const w = await mount(t, { beforeClose: (params) => { asked.push(String(params.id)); return !keep.has(String(params.id)); } });
  const base = w.tree.defaultIslandTree();
  let popup = w.tree.openFloat(base, { type: FAKE, params: { id: 'a' } }, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }).tree;
  const leafId = popup.floats![0]!.leaf.id;
  popup = w.tree.addTab(popup, leafId, { type: FAKE, params: { id: 'b' } }).tree;
  await w.render(popup, true);
  const cross = () => document.querySelector<HTMLElement>(`[data-island="${leafId}"] [data-island-close]`)!;
  await w.act(() => { cross().click(); });
  assert.deepEqual(asked, ['a', 'b'], 'each tab is asked, in order');
  assert.equal(w.calls.length, 0, 'nothing written: neither tab closed');
  assert.equal(document.querySelectorAll(`[data-island="${leafId}"] [role="tab"]`).length, 2);

  keep.clear();
  await w.act(() => { cross().click(); });
  assert.equal(w.calls.at(-1)!.tree.floats?.length ?? 0, 0, 'the island closes once every tab agrees');
});

test('beforeClose: a type that throws or rejects keeps its tab, and a programmatic close never asks', async (t) => {
  let asked = 0;
  let fail: 'throw' | 'reject' = 'throw';
  const w = await mount(t, { beforeClose: () => {
    asked += 1;
    if (fail === 'throw') throw new Error('broken plugin');
    return Promise.reject(new Error('broken plugin'));
  } });
  const base = w.tree.defaultIslandTree();
  let tree = w.tree.addTab(base, base.root.id, { type: FAKE, params: { id: 'a' } }).tree;
  tree = w.tree.addTab(tree, base.root.id, { type: FAKE, params: { id: 'b' } }).tree;
  await w.render(tree, true);
  const tabs = () => Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'));
  const errors: unknown[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  t.after(() => { console.error = error; });
  await w.act(() => { key(tabs()[2]!, 'Delete'); });
  assert.equal(asked, 1);
  assert.equal(tabs().length, 3, 'a guard that breaks keeps the work it guards');
  fail = 'reject';
  await w.act(() => { key(tabs()[2]!, 'Delete'); });
  await w.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.equal(asked, 2);
  assert.equal(tabs().length, 3, 'a rejection keeps it too');
  assert.equal(errors.length, 2, 'each failure is logged');
  const opened = w.tree.collectLeaves((w.calls.at(-1)?.tree ?? tree).root).flatMap((leaf) => leaf.tabs);
  const tabA = opened.find((x) => x.content.params.id === 'a')!;
  const tabB = opened.find((x) => x.content.params.id === 'b')!;
  await w.act(() => { w.bus.closeIslandTab(tabA.id); w.bus.closeIslandTab(tabB.id); });
  assert.equal(asked, 2, 'the host closing a tab itself does not ask');
  assert.equal(tabs().length, 0, 'the page is alone again');
});

// TIM-0140, the tester's steps: the main agent's view split in two, the
// coder's conversation picked in the page's panel, the main agent's beside it;
// another view; back by the main agent's tab of the top bar, which names its
// running conversation. Both panels come back as they were, the page's titled
// after the agent it shows, and the view stays the main agent's.
test('a split chat view keeps the coder in its page panel across a round trip to another view (TIM-0140)', async (t) => {
  const w = await mount(t);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PathnameContext, SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WorkspaceLayoutProvider } = await import('@/components/workspace-layout-provider');
  const { IslandWorkspace, ISLANDS_SUFFIX } = await import('./island-workspace');
  const { useIslandContent } = await import('./island-content');
  const { usePageChat } = await import('@/app/chat/use-page-chat');
  const { workspaceScope } = await import('@/lib/workspace-scope');
  const { CHAT_ISLAND_TYPE, chatIslandContent, parseChatIslandParams } = await import('@/lib/chat-island-params');
  const { chatPin } = await import('@/lib/chat-entry');
  const slots = await import('@/lib/plugin-host/slots');

  // A chat island that shows what its params say (the real one mounts a ChatClient).
  function ChatStub() {
    const { params, setTitle } = useIslandContent();
    // Titled after its agent, as `ChatIsland` is.
    React.useEffect(() => { setTitle(String(params.agent)); }, [params.agent, setTitle]);
    return React.createElement('p', { 'data-chat-island': `${String(params.agent)}:${String(params.missionId)}` });
  }
  const disposeChat = slots.register({
    slot: 'island.content',
    pluginId: '@rooks/missions',
    key: 'chat',
    island: { title: 'Chat', parseParams: parseChatIslandParams },
  }, ChatStub);

  // A project of its own: the provider remembers resolved routes for the module's life.
  const owner = 'tim0140-owner';
  const project = 'tim0140';
  const main = `${project}.main`;
  const coder = `${project}.coder`;
  const islands = `${await workspaceScope(owner, '/chat', project)}.${ISLANDS_SUFFIX}`;
  // The view as the tester had it before the switch: page panel + the main agent's chat beside.
  const base = w.tree.defaultIslandTree();
  const split = w.tree.insertAt(base, base.root.id, 'right', chatIslandContent(main, 'm-main')).tree;
  const rows = new Map<string, unknown>([[islands, JSON.parse(JSON.stringify(split))]]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/ui/auth/me') return Response.json({ user: { id: owner } });
    if (url.pathname.startsWith('/api/ui/agents/')) return Response.json({ agent: { project } });
    if (url.pathname.includes('layout')) {
      const scope = url.searchParams.get('scope') ?? '';
      const method = init?.method ?? 'GET';
      if (method === 'GET') return Response.json({ layout: rows.get(scope) ?? null });
      if (method === 'DELETE') { rows.delete(scope); return Response.json({ ok: true }); }
      rows.set(scope, (JSON.parse(String(init?.body)) as { layout: unknown }).layout);
      return Response.json({ ok: true });
    }
    return Response.json({});
  }) as typeof fetch;

  // The page's panel: what `ChatRoute` mounts, minus the conversation itself.
  let keep: ((missionId: string, owner: string) => boolean) | undefined;
  function PagePanel({ params }: { params: URLSearchParams }) {
    const page = usePageChat(params);
    keep = page.keepInView;
    return React.createElement('div', { id: 'page-chat', 'data-mission': page.chatParams.get('mission') ?? '' });
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let address = new URL(`http://localhost/chat?agent=${main}&mission=m-main`);
  const show = (pathname: string, search: URLSearchParams) => w.act(() => {
    root.render(React.createElement(PathnameContext.Provider, { value: pathname },
      React.createElement(SearchParamsContext.Provider, { value: search as never },
        React.createElement(WorkspaceLayoutProvider, null,
          React.createElement(IslandWorkspace, {
            route: pathname === '/chat' ? React.createElement(PagePanel, { params: search }) : React.createElement('div', { id: 'other-view' }),
          })))));
  });
  const goTo = (href: string) => { address = new URL(href, 'http://localhost'); return show(address.pathname, new URLSearchParams(address.search)); };
  // Called by the test itself, like `mountStored`'s: `mount`'s cleanup tears the DOM down first.
  const close = async () => { await w.act(() => root.unmount()); globalThis.fetch = originalFetch; disposeChat(); };
  const until = (condition: () => boolean, what: string) => waitUntil(w.act, condition, what);
  const pageMission = () => host.querySelector<HTMLElement>('#page-chat')?.dataset.mission;
  const beside = () => host.querySelector<HTMLElement>('[data-chat-island]')?.dataset.chatIsland;
  // A single tab is titled in its island's handle, several in a tab bar.
  const titles = () => Array.from(host.querySelectorAll<HTMLElement>('[data-island-tab-handle], [role="tab"]')).map((tab) => tab.textContent ?? '');

  await goTo(address.toString());
  await until(() => beside() === `${main}:m-main` && keep !== undefined, 'the stored split to be painted');
  assert.equal(pageMission(), 'm-main');

  // The coder's conversation picked in the page's rail, then bound: what
  // `ChatClient.pinMissionInUrl` does with it.
  const kept = keep!('m-coder', coder);
  assert.equal(kept, true, 'kept in the page panel');
  const pinned = chatPin(address, 'm-coder', coder, kept, { __NA: true });
  assert.equal(pinned?.state, null, 'the router hears it');
  await goTo(pinned!.href);
  await until(() => JSON.stringify(rows.get(islands)).includes('m-coder'), 'the kept conversation to be stored');
  assert.equal(address.searchParams.get('agent'), main, 'the view keeps its agent');
  assert.equal(pageMission(), 'm-coder');
  assert.ok(titles().some((title) => title.includes(coder)), `the page panel is titled after the coder: ${titles().join(' | ')}`);
  assert.deepEqual(titles().filter((title) => title.includes(main)).length, 1, `one tab titled after the main agent, the one beside: ${titles().join(' | ')}`);
  assert.equal(beside(), `${main}:m-main`);

  // Another view, then back by the main agent's tab: `chatHref(main, its running mission)`.
  await goTo('/kanban');
  await until(() => !!host.querySelector('#other-view'), 'the other view');
  await goTo(`/chat?agent=${main}&mission=m-main`);
  await until(() => !!host.querySelector('#page-chat') && beside() === `${main}:m-main`, 'the chat view back');
  assert.equal(pageMission(), 'm-coder', 'the page panel shows the coder again');
  assert.ok(titles().some((title) => title.includes(coder)), `titled after the coder again: ${titles().join(' | ')}`);
  assert.equal(beside(), `${main}:m-main`, 'the main agent beside, as it was');

  // The New picker of the page's chat, on the main agent: a blank
  // conversation of the main agent, not the kept one.
  await goTo(`/chat?agent=${main}&fresh=1`);
  await until(() => pageMission() === '', 'a new conversation on the main view');
  assert.ok(titles().every((title) => !title.includes(coder)), `nothing of the coder over a new conversation: ${titles().join(' | ')}`);
  await goTo(`/chat?agent=${main}&mission=m-main`);
  await until(() => pageMission() === 'm-coder', 'the main view back');

  // Another agent of the same project reads the same row: its view is its own.
  await goTo(`/chat?agent=${project}.reviewer`);
  await until(() => !!host.querySelector('#page-chat'), 'the reviewer\'s view');
  assert.equal(pageMission(), '', 'the reviewer\'s page follows its URL');
  assert.ok(!titles().some((title) => title.includes(coder)), 'nothing of the coder on the reviewer\'s view');

  // Back on the main view, the page picks one of the main agent's own
  // conversations: what it kept goes, and a link wins over it.
  await goTo(`/chat?agent=${main}&mission=m-main`);
  await until(() => pageMission() === 'm-coder', 'the main view back');
  assert.equal(keep!('m-main-2', main), false, 'the view\'s own agent: the URL says it');
  await until(() => !JSON.stringify(rows.get(islands)).includes('m-coder'), 'the kept conversation to be forgotten');
  assert.equal(w.tree.routeParams(w.tree.readIslandTree(rows.get(islands))).view, undefined);
  assert.equal(CHAT_ISLAND_TYPE, '@rooks/missions:chat');
  await close();
});
