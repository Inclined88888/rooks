/**
 * Triggers page (TODO #216): the three tabs, the `?tab=` they keep, the
 * loopback notice of the webhooks, and `/routines` landing on the Routines tab.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

type Mod = { id: string; tier: string; active: boolean; reason: null; missing: string[] };
const mod = (id: string, active: boolean): Mod => ({ id, tier: 'std', active, reason: null, missing: [] });

test('Triggers page: tabs, deep link, loopback notice and the /routines redirect', async (suite) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/triggers?tab=events', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    install(key, key === 'window' ? dom.window : typeof value === 'function' && /^[a-z]/.test(key) ? value.bind(dom.window) : value);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { fetchCapabilities, resetCapabilitiesCacheForTests } = await import('./capabilities');
  const { TriggersPage } = await import('../plugins-client/triggers/triggers-page');
  const { RoutinesRedirect } = await import('../plugins-client/triggers/redirect');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');

  const originalFetch = globalThis.fetch;
  let modules: Mod[] = [mod('@rooks/triggers', true), mod('@rooks/routines', true)];
  const fetched: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    fetched.push(url);
    if (url === '/api/ui/capabilities') {
      return Response.json({ edition: 'expert', profile: 'host', capabilities: [], modules, ui: { hidden: [], home: '/' }, kernel: true, developer: { unsignedPlugins: false } });
    }
    if (url.startsWith('/api/ui/triggers?source=')) return Response.json({ triggers: [] });
    if (url === '/api/ui/routines') return Response.json({ routines: [] });
    if (url === '/api/ui/agents') return Response.json({ agents: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  const root = createRoot(document.getElementById('root')!);
  const settle = async () => { await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const render = async (element: React.ReactElement) => {
    await React.act(async () => root.render(element));
    await settle();
    await settle();
  };
  const tabs = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const activeTab = () => tabs().find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent ?? null;
  const pick = async (label: string) => {
    const tab = tabs().find((el) => el.textContent === label);
    assert.ok(tab, `tab ${label}`);
    // Radix selects a tab on mouse down, not on click.
    await React.act(async () => { tab.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 })); });
    await settle();
  };

  try {
    await suite.test('a deep link opens its tab, among the three', async () => {
      resetCapabilitiesCacheForTests();
      await render(React.createElement(TriggersPage));
      assert.deepEqual(tabs().map((tab) => tab.textContent), ['Routines', 'Webhooks', 'Events']);
      assert.equal(activeTab(), 'Events');
      assert.ok(fetched.includes('/api/ui/triggers?source=event'));
      assert.ok(!document.querySelector('[role="note"]'), 'the loopback notice belongs to the webhooks');
    });

    await suite.test('switching tab keeps it in the address and shows the loopback notice for webhooks', async () => {
      await pick('Webhooks');
      assert.equal(activeTab(), 'Webhooks');
      assert.equal(window.location.search, '?tab=webhooks');
      assert.ok(fetched.includes('/api/ui/triggers?source=webhook'));
      assert.match(document.querySelector('[role="note"]')?.textContent ?? '', /loopback/);
      assert.match(document.querySelector('[role="note"]')?.textContent ?? '', /tunnel or a reverse proxy/);

      await pick('Routines');
      assert.equal(window.location.search, '?tab=routines');
      assert.ok(fetched.includes('/api/ui/routines'), 'the routines keep their own list');
      assert.ok(fetched.includes('/api/ui/triggers?source=schedule'));
    });

    await suite.test('without the triggers module only the Routines tab remains', async () => {
      await React.act(async () => root.render(React.createElement('div')));
      modules = [mod('@rooks/triggers', false), mod('@rooks/routines', true)];
      resetCapabilitiesCacheForTests();
      // The catch-all paints a plugin page once capabilities are known.
      await fetchCapabilities(true);
      window.history.replaceState(null, '', '/triggers?tab=webhooks');
      fetched.length = 0;
      await render(React.createElement(TriggersPage));
      assert.deepEqual(tabs().map((tab) => tab.textContent), ['Routines']);
      assert.equal(activeTab(), 'Routines', 'an unknown or hidden tab falls back to the first one');
      assert.equal(fetched.some((url) => url.startsWith('/api/ui/triggers')), false);
    });

    await suite.test('/routines lands on the Routines tab of /triggers', async () => {
      const replaced: string[] = [];
      const router = {
        back() {}, forward() {}, refresh() {}, prefetch() {},
        push(href: string) { replaced.push(`push:${href}`); },
        replace(href: string) { replaced.push(href); },
      };
      await render(React.createElement(AppRouterContext.Provider, { value: router }, React.createElement(RoutinesRedirect)));
      assert.deepEqual(replaced, ['/triggers?tab=routines']);
    });
  } finally {
    await React.act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    dom.window.close();
  }
});
