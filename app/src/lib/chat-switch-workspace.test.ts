/**
 * Opening the chat of an agent from ANOTHER project (Working agents' tab, the
 * agents graph, a notification) looked like a page reload (28/10/2026): the
 * document stayed, but the workspace key fell back to `null` for the two reads
 * it takes to resolve the new project, so the top bar emptied, the island
 * tree went back to its default, then everything was painted again under the
 * new key. What this locks: a chat switch keeps the previous screen until the
 * next workspace is resolved and its rows are read, then commits once, with
 * the new project's key and its layout already known.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { waitUntil } from './test-wait';

type Commit = { key: string | null; widgetsKnown: boolean; islands: unknown };

type Install = (key: string, value: unknown) => void;

/** A jsdom window installed as the globals React and the app read; `restore` puts them back. */
async function installDom(url: string): Promise<{ install: Install; restore: () => void }> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url, pretendToBeVisual: true });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install: Install = (key, value) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element',
    'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event',
    'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, dom.window[key]);
  install('CSS', { escape: (value: string) => value });
  const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  install('matchMedia', matchMedia);
  dom.window.matchMedia = matchMedia as unknown as Window['matchMedia'];
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  install('EventSource', class { close() {} addEventListener() {} removeEventListener() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  return {
    install,
    restore: () => {
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

test('a chat switch to another project never commits an unresolved workspace', async () => {
  const { install, restore } = await installDom('http://localhost/chat?agent=A');
  const projects: Record<string, string> = { A: 'p1', B: 'p2' };
  install('fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url === '/api/ui/auth/me') return Response.json({ user: { id: 'owner' } });
    const agent = /^\/api\/ui\/agents\/([^/?]+)$/.exec(url)?.[1];
    if (agent && projects[agent]) return Response.json({ agent: { name: agent, project: projects[agent] } });
    if (url.startsWith('/api/ui/layout?')) {
      const scope = new URL(url, 'http://localhost').searchParams.get('scope') ?? '';
      return Response.json({ layout: scope.endsWith('.islands') ? { stored: scope } : null, updatedAt: 1 });
    }
    return Response.json({ modules: [], ui: { hidden: [] }, agents: [], missions: [], items: [], events: [] });
  });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { PathnameContext, SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WorkspaceLayoutProvider, useWorkspaceLayout } = await import('../components/workspace-layout-provider');
  const { useStoredLayout } = await import('../hooks/use-stored-layout');
  const { workspaceScope } = await import('./workspace-scope');
  const { ThemeProvider } = await import('../components/theme-provider');
  const { WidgetHost } = await import('../components/widget-host/widget-host');
  const { ChatRoute } = await import('../app/chat/chat-route');
  const { getLocale, setLocale } = await import('./i18n');
  const locale = getLocale();
  setLocale('en');

  const commits: Commit[] = [];
  /** What a consumer of the root layout (the widget host, the islands) shows, per commit. */
  function Screen() {
    const { key } = useWorkspaceLayout();
    const widgets = useStoredLayout(key ? `${key}.widgets` : null);
    const islands = useStoredLayout(key ? `${key}.islands` : null);
    React.useLayoutEffect(() => { commits.push({ key, widgetsKnown: widgets.known, islands: islands.raw }); });
    return null;
  }
  let navigate: (query: string) => void = () => {};
  /**
   * Next 14.2's `ACTION_RESTORE`, as it really lands: the patched `pushState`
   * dispatches it in a `startTransition`, but the action queue runs an `async`
   * reducer and calls `setState` in its `.then` — outside the transition, at
   * default priority (`next/dist/shared/lib/router/action-queue.js`). Driving
   * the test with a synchronous `startTransition(setParams)` is what hid the
   * fallback the built app showed (task 3d22e2fb).
   */
  function App() {
    const [params, setParams] = React.useState(() => new URLSearchParams('agent=A'));
    navigate = (query) => React.startTransition(() => { void Promise.resolve().then(() => setParams(new URLSearchParams(query))); });
    return React.createElement(ThemeProvider, null, React.createElement(PathnameContext.Provider, { value: '/chat' },
      React.createElement(SearchParamsContext.Provider, { value: params as never },
        React.createElement(WorkspaceLayoutProvider, null,
          React.createElement(WidgetHost, null,
            React.createElement(Screen),
            React.createElement(ChatRoute))))));
  }
  const router = { back() {}, forward() {}, refresh() {}, prefetch() {}, push() {}, replace() {} };
  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  try {
    const p1 = await workspaceScope('owner', '/chat', 'p1');
    const p2 = await workspaceScope('owner', '/chat', 'p2');
    await React.act(async () => {
      root.render(React.createElement(AppRouterContext.Provider, { value: router as never }, React.createElement(App)));
    });
    await until(() => commits.at(-1)?.key === p1 && commits.at(-1)!.widgetsKnown, 'the first project to be resolved and read');
    commits.length = 0;
    // A Suspense fallback keeps the hidden content in the DOM: what counts is
    // whether "Loading…" is ever painted in its place.
    let fallbackShown = false;
    const watch = new MutationObserver(() => {
      if (Array.from(document.querySelectorAll('[role="status"]')).some((el) => el.textContent?.includes('Loading'))) fallbackShown = true;
    });
    watch.observe(document.body, { childList: true, subtree: true });
    const topBar = document.querySelector('header');
    const islands = document.querySelector('[data-island-workspace]');
    assert.ok(topBar && islands, 'the chat page paints its top bar and its island workspace');

    await React.act(async () => { navigate('agent=B&mission=m2'); });
    await until(() => commits.at(-1)?.key === p2, 'the switch to land on the second project');
    // What the eye reads as a reload, measured in the built app (task
    // 3d22e2fb): the conversation is keyed on `agent:mission`, and the top bar
    // and the islands used to live inside it, so every switch threw them away
    // and painted new ones, the strip first holding the open chat's tab alone.
    // `ok(===)`, not `equal`: a failing `equal` inspects both jsdom nodes, the
    // whole document behind them, and runs out of memory before reporting.
    assert.ok(document.querySelector('header') === topBar, 'the top bar is the same element, not a new one');
    assert.ok(document.querySelector('[data-island-workspace]') === islands, 'the island workspace is the same element');
    watch.disconnect();
    assert.equal(fallbackShown, false, 'the previous conversation stays on screen, never a "Loading…" fallback');
    assert.deepEqual(commits.filter((c) => c.key === null), [], 'the workspace key never falls back to null');
    assert.ok(commits.every((c) => c.key !== p2 || c.widgetsKnown), 'the new project paints its own layout, not an empty board');
    assert.deepEqual(commits.find((c) => c.key === p2)?.islands, { stored: `${p2}.islands` }, 'the islands commit with their stored tree');
  } finally {
    await React.act(async () => root.unmount());
    setLocale(locale);
    restore();
  }
});

/**
 * The epoch (review of 28/10/2026): a switch's read-ahead started under one
 * account and answered after the logout must land nowhere — neither its route
 * nor its rows may reach the next account's screen, nor announce the previous
 * account again. Three read-aheads are caught by the logout at three stages:
 * X with its identity resolved and its rows on the wire, Y with its identity
 * on the wire (both answered before Bob signs in), Z answered only once Bob
 * already stands on Z.
 */
test('a read-ahead begun under one account never lands in the next one', async () => {
  const { install, restore } = await installDom('http://localhost/login');
  const projects: Record<string, string> = { W: 'p1', X: 'p2', Y: 'p3', Z: 'p4' };
  let session: 'alice' | 'bob' | null = 'alice';
  /** Requests Alice's session sent and that are answered only on `release`. */
  const held: Array<{ url: string; release: () => void }> = [];
  let hold: (url: string) => boolean = () => false;
  const answer = (url: string, who: string | null): Response => {
    if (url === '/api/ui/auth/me') return who ? Response.json({ user: { id: who } }) : Response.json({ error: 'unauthenticated' }, { status: 401 });
    const agent = /^\/api\/ui\/agents\/([^/?]+)$/.exec(url)?.[1];
    if (agent && projects[agent]) return Response.json({ agent: { name: agent, project: projects[agent] } });
    if (url.startsWith('/api/ui/layout?')) {
      const scope = new URL(url, 'http://localhost').searchParams.get('scope') ?? '';
      return Response.json({ layout: scope.endsWith('.islands') ? { stored: scope, by: who } : null, updatedAt: 1 });
    }
    return Response.json({ modules: [], ui: { hidden: [] }, agents: [], missions: [], items: [], events: [] });
  };
  install('fetch', (input: string | URL | Request) => {
    const url = String(input);
    const who = session;
    if (who === 'alice' && hold(url)) {
      return new Promise<Response>((resolve) => { held.push({ url, release: () => resolve(answer(url, who)) }); });
    }
    return Promise.resolve(answer(url, who));
  });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { PathnameContext, SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WorkspaceLayoutProvider, useWorkspaceLayout, preloadWorkspace } = await import('../components/workspace-layout-provider');
  const { useStoredLayout, peekStoredLayout } = await import('../hooks/use-stored-layout');
  const { onAccountChange } = await import('./account-change');
  const { workspaceScope } = await import('./workspace-scope');
  const { ThemeProvider } = await import('../components/theme-provider');
  const { WidgetHost } = await import('../components/widget-host/widget-host');
  const { ChatRoute } = await import('../app/chat/chat-route');
  const { getLocale, setLocale } = await import('./i18n');
  const locale = getLocale();
  setLocale('en');

  type Shown = { key: string | null; islands: unknown };
  const commits: Shown[] = [];
  function Screen() {
    const { key } = useWorkspaceLayout();
    const islands = useStoredLayout(key ? `${key}.islands` : null);
    React.useLayoutEffect(() => { commits.push({ key, islands: islands.raw }); });
    return null;
  }
  let navigate: (path: string, query: string) => void = () => {};
  function App() {
    // Signed in from the login page, as any account is: it is the boundary the
    // memory of a previous one (here, the test above) is dropped at.
    const [at, setAt] = React.useState(() => ({ path: '/login', params: new URLSearchParams() }));
    navigate = (path, query) => React.startTransition(() => setAt({ path, params: new URLSearchParams(query) }));
    return React.createElement(ThemeProvider, null, React.createElement(PathnameContext.Provider, { value: at.path },
      React.createElement(SearchParamsContext.Provider, { value: at.params as never },
        React.createElement(WorkspaceLayoutProvider, null,
          React.createElement(WidgetHost, null,
            React.createElement(Screen),
            at.path === '/chat' ? React.createElement(ChatRoute) : null)))));
  }
  const announced: Array<string | null> = [];
  const unsubscribe = onAccountChange((owner) => { announced.push(owner); });
  const router = { back() {}, forward() {}, refresh() {}, prefetch() {}, push() {}, replace() {} };
  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const release = async (which: (url: string) => boolean) => {
    for (const request of held.filter(({ url }) => which(url))) {
      held.splice(held.indexOf(request), 1);
      request.release();
    }
    // Every answer chains a few reads (identity, then the rows and their
    // legacy fallback): let them all land before looking.
    for (let i = 0; i < 10; i++) await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  };
  const keys = async (owner: string) => Promise.all(['p1', 'p2', 'p3', 'p4'].map((project) => workspaceScope(owner, '/chat', project)));
  const isLayout = (url: string) => url.startsWith('/api/ui/layout?');
  try {
    const alice = await keys('alice');
    const bob = await keys('bob');
    await React.act(async () => {
      root.render(React.createElement(AppRouterContext.Provider, { value: router as never }, React.createElement(App)));
    });
    await until(() => announced.includes(null), 'the login page');
    await React.act(async () => { navigate('/chat', 'agent=W'); });
    await until(() => commits.at(-1)?.key === alice[0], 'Alice\'s first chat to be resolved');

    // X: identity answered, its rows held.
    hold = isLayout;
    preloadWorkspace('/chat', new URLSearchParams('agent=X'));
    await until(() => held.some(({ url }) => url.includes(encodeURIComponent(`${alice[1]}.islands`))), 'X\'s rows to be asked for');
    // Y and Z: identity held (one shared `auth/me`), Z's agent read held on its own.
    hold = (url) => url === '/api/ui/auth/me' || url.startsWith('/api/ui/agents/') || isLayout(url);
    preloadWorkspace('/chat', new URLSearchParams('agent=Y'));
    preloadWorkspace('/chat', new URLSearchParams('agent=Z'));
    await until(() => held.some(({ url }) => url === '/api/ui/agents/Z'), 'Y and Z to be resolving');

    session = null;
    await React.act(async () => { navigate('/login', ''); });
    await until(() => announced.at(-1) === null, 'the login page to purge the memory');
    const since = commits.length;
    const afterLogin = announced.length;

    await release((url) => url !== '/api/ui/agents/Z');
    assert.deepEqual(announced.slice(afterLogin), [], 'an answer for Alice does not announce her again');
    for (const key of [alice[1], alice[2], alice[3]]) {
      for (const row of ['widgets', 'columns', 'appearance', 'islands']) {
        assert.equal(peekStoredLayout(`${key}.${row}`), undefined, `Alice's ${row} row is not remembered`);
      }
    }

    session = 'bob';
    // Alice's last route first: the provider's state still described it.
    await React.act(async () => { navigate('/chat', 'agent=W'); });
    await until(() => commits.at(-1)?.key === bob[0], 'Bob\'s first chat');
    await React.act(async () => { navigate('/chat', 'agent=X&mission=m2'); });
    await until(() => commits.at(-1)?.key === bob[1], 'Bob\'s switch to X');
    await React.act(async () => { navigate('/chat', 'agent=Y&mission=m3'); });
    await until(() => commits.at(-1)?.key === bob[2], 'Bob\'s switch to Y');
    await React.act(async () => { navigate('/chat', 'agent=Z&mission=m4'); });
    await until(() => commits.at(-1)?.key === bob[3], 'Bob\'s switch to Z, while Alice\'s read of Z is still on the wire');
    await release(() => true);

    const shown = commits.slice(since);
    assert.deepEqual(shown.filter(({ key }) => key !== null && alice.includes(key)), [], 'no commit is keyed by Alice\'s workspace');
    assert.deepEqual(
      shown.filter(({ islands }) => (islands as { by?: string } | null)?.by === 'alice'),
      [],
      'no commit paints a row read for Alice',
    );
    assert.equal(commits.at(-1)?.key, bob[3], 'Bob stays on his own workspace once Alice\'s last answer lands');
    assert.deepEqual((commits.at(-1)?.islands as { by?: string } | null)?.by, 'bob');
    assert.ok(announced.slice(afterLogin).every((owner) => owner === 'bob'), 'only Bob is announced after the login page');
  } finally {
    unsubscribe();
    await React.act(async () => root.unmount());
    setLocale(locale);
    restore();
  }
});

test('a workspace that cannot be resolved stops holding the switch', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ error: 'down' }, { status: 503 }); };
  try {
    const { workspaceWait } = await import('../components/workspace-layout-provider');
    const params = new URLSearchParams('agent=Unreachable');
    const wait = workspaceWait('/chat', params);
    assert.ok(wait, 'the switch waits for the read');
    await wait;
    assert.equal(workspaceWait('/chat', params), null, 'a failed read lets the screen paint as before');
    const asked = calls;
    workspaceWait('/chat', params);
    assert.equal(calls, asked, 'the retry render does not ask again');
  } finally { globalThis.fetch = original; }
});
