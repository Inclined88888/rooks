import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';

/**
 * The maintainer's request: on a phone the agent tabs are a top bar of their own, stuck under the
 * menu bar, and they stay when the menu bar hides on scroll. The row lives in
 * the sticky header but outside the part that folds.
 */

type Dom = { window: Window & typeof globalThis };

async function withDom<T>(run: (dom: Dom, react: typeof import('react')) => Promise<T>): Promise<T> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver', 'Event', 'KeyboardEvent', 'getComputedStyle', 'localStorage', 'matchMedia', 'CustomEvent', 'EventTarget']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  try {
    return await run(dom as unknown as Dom, React);
  } finally {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  }
}

class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }

async function renderTopBar(collapsed: boolean, run: (host: HTMLElement) => void) {
  await withDom(async (dom, React) => {
    (dom.window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    (globalThis as Record<string, unknown>).matchMedia = (dom.window as unknown as { matchMedia: unknown }).matchMedia;
    (globalThis as Record<string, unknown>).ResizeObserver = NoopResizeObserver;
    const savedFetch = globalThis.fetch;
    const agents = [{ name: 'timon.main', state: 'thinking', mission_id: 'm1', at: Date.now(), pending_count: 0, project: null }];
    globalThis.fetch = (async (input: string) => {
      const url = String(input);
      if (url === '/api/ui/auth/me') return Response.json({ user: { id: 'owner' } });
      // Nothing stored: the Working agents widget takes its default place.
      if (url.startsWith('/api/ui/layout?scope=')) return Response.json({ layout: null });
      if (url.includes('/agents/active')) return Response.json({ agents });
      // The open chat's agent: the workspace resolves its project from it.
      if (url === '/api/ui/agents/timon.main') return Response.json({ agent: { name: 'timon.main', project: null } });
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    // The tabs are the Working agents widget, placed by default in the
    // middle of the bar (the phone row on a phone).
    const { register, declareSlot, resetSlotsForTests } = await import('@/lib/plugin-host/slots');
    const { WorkingAgentsWidget } = await import('@/plugins-client/working-agents/working-agents-widget');
    resetSlotsForTests();
    declareSlot('cockpit.widget', 'list');
    register({ slot: 'cockpit.widget', pluginId: '@timon/agents', key: 'working', widget: { title: 'Working agents', frame: 'none', bar: true, placedByDefault: true, zone: 'topbar.center.widget' } }, WorkingAgentsWidget as never);
    const { createRoot } = await import('react-dom/client');
    const { TopBar } = await import('@/components/topbar');
    const { ThemeProvider } = await import('@/components/theme-provider');
    const { WidgetHost } = await import('@/components/widget-host/widget-host');
    const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
    const { PathnameContext, SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
    const { WorkspaceLayoutProvider } = await import('@/components/workspace-layout-provider');
    const router = { back() {}, forward() {}, refresh() {}, prefetch() {}, push() {}, replace() {} };
    const host = document.getElementById('root')!;
    const root = createRoot(host);
    try {
      await React.act(async () => {
        root.render(React.createElement(AppRouterContext.Provider, { value: router },
          React.createElement(PathnameContext.Provider, { value: '/chat' },
            React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams('agent=timon.main') },
              React.createElement(WorkspaceLayoutProvider, null,
                React.createElement(ThemeProvider, null,
                  React.createElement(WidgetHost, null, React.createElement(TopBar, { collapsed }))))))));
      });
      await waitUntil(React.act, () => !!host.querySelector('a[href^="/chat?agent=timon.main"]'), 'the agent tab to be painted');
      run(host);
    } finally {
      await React.act(async () => { root.unmount(); });
      globalThis.fetch = savedFetch;
      delete (globalThis as Record<string, unknown>).ResizeObserver;
      resetSlotsForTests();
    }
  });
}

test('on a phone the agent tabs have their own row, outside the folding bar', async () => {
  await renderTopBar(true, (host) => {
    const header = host.querySelector('header')!;
    const bar = header.querySelector('.timon-topbar-bar')!;
    const row = header.querySelector('.timon-topbar-agents')!;
    assert.ok(bar && row);
    assert.ok(!bar.contains(row), 'the row is not inside the part that folds');
    assert.match(bar.className, /-translate-y-full/, 'the menu bar slides up out of view');
    assert.doesNotMatch(bar.className, /opacity-0/, 'opaque while it slides: no fade over the agents row');
    const fold = header.querySelector<HTMLElement>('[data-topbar-fold]')!;
    assert.equal(fold.dataset.topbarFold, 'folded');
    assert.match(fold.className, /(^| )h-0( |$)/, 'its row folds to zero height at once');
    assert.doesNotMatch(fold.className, /transition/, 'no layout animation: the slide is transforms only');
    assert.doesNotMatch(bar.className, /transition/, 'the bar slides by script, in step with the agents row and the page');
    assert.doesNotMatch(row.className, /max-h-0|opacity-0/, 'the agents row is not');
    assert.match(row.className, /md:hidden/, 'a phone row only');
    assert.ok(row.querySelector('a[href^="/chat?agent=timon.main"]'), 'the tab is in the phone row');
  });
});

test('the header clears the iOS status bar before the menu bar and the agents row', async () => {
  await renderTopBar(false, (host) => {
    const header = host.querySelector('header')!;
    const safe = header.firstElementChild!.firstElementChild!;
    assert.match(safe.className, /safe-area-inset-top/);
  });
});
