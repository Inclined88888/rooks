/**
 * Onboarding Light | System switch under ThemeProvider: Light is the default;
 * System follows the OS; a pick paints at once and outlives a navigation.
 */
import '@/lib/i18n-test-locales';
import assert from 'node:assert/strict';
import test from 'node:test';

type Dom = { window: Window & typeof globalThis };

async function render(osLight: boolean, stored: string | null, run: (host: HTMLElement, dom: Dom, react: typeof import('react')) => Promise<void>): Promise<void> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/onboarding', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown): void => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  const listeners: Array<() => void> = [];
  (dom.window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: query.includes('light') ? osLight : !osLight,
    addEventListener: (_: string, fn: () => void) => { listeners.push(fn); },
    removeEventListener: () => {},
    addListener: (fn: () => void) => { listeners.push(fn); },
    removeListener: () => {},
  });
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver', 'Event', 'getComputedStyle', 'localStorage', 'sessionStorage', 'matchMedia']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  if (stored) dom.window.sessionStorage.setItem('rooks-onboarding-scheme', stored);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async () => new Response(JSON.stringify({ user: null }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { PathnameContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { ThemeProvider } = await import('@/components/theme-provider');
  const { SchemeSwitch } = await import('./scheme-switch');
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  try {
    await React.act(async () => {
      root.render(React.createElement(PathnameContext.Provider, { value: '/onboarding' },
        React.createElement(ThemeProvider, { initialScheme: 'light', children: React.createElement(SchemeSwitch) })));
    });
    await run(host, dom as unknown as Dom, React);
  } finally {
    await React.act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

const pressed = (host: HTMLElement): string | null => host.querySelector('[aria-pressed="true"]')?.getAttribute('data-scheme') ?? null;

test('the switch defaults to Light, never offers Dark, and System follows the OS', async () => {
  await render(false, null, async (host, dom, React) => {
    const { firstRunScheme } = await import('@/lib/first-run-gate');
    assert.equal(pressed(host), 'light', 'no pick yet: Light is the default');
    assert.equal(host.querySelector('[data-scheme="dark"]'), null, 'Dark is not a manual choice');
    assert.equal(firstRunScheme(), 'light', 'no pick: first launch stays light even when OS is dark');
    assert.ok(dom.window.document.documentElement.classList.contains('light'));

    await React.act(async () => { (host.querySelector('[data-scheme="system"]') as HTMLElement).click(); });
    assert.equal(pressed(host), 'system');
    assert.ok(dom.window.document.documentElement.classList.contains('dark'), 'System + OS dark paints dark');
    assert.equal(dom.window.sessionStorage.getItem('rooks-onboarding-scheme'), 'dark');
    assert.equal(dom.window.localStorage.getItem('rooks.appearance.schemeMode'), 'system');
  });
});

test('picking Light paints light and stores the mode', async () => {
  await render(true, null, async (host, dom, React) => {
    const { firstRunScheme } = await import('@/lib/first-run-gate');
    await React.act(async () => { (host.querySelector('[data-scheme="system"]') as HTMLElement).click(); });
    await React.act(async () => { (host.querySelector('[data-scheme="light"]') as HTMLElement).click(); });
    assert.equal(pressed(host), 'light');
    assert.ok(dom.window.document.documentElement.classList.contains('light'));
    assert.equal(dom.window.sessionStorage.getItem('rooks-onboarding-scheme'), 'light');
    assert.equal(firstRunScheme(), 'light');
    assert.equal(dom.window.localStorage.getItem('rooks.appearance.schemeMode'), 'light');
  });
});

test('a Light pick made earlier in the flow survives a full navigation', async () => {
  await render(false, 'light', async (host) => {
    assert.equal(pressed(host), 'light', 'stored Light wins over OS dark');
  });
});

test('the switch speaks the active language', async () => {
  const { loadLocale } = await import('@/lib/i18n');
  await render(false, null, async (host) => {
    assert.equal(host.querySelector('[role="group"]')?.getAttribute('aria-label'), 'Colour mode');
  });
  await loadLocale('fr');
  try {
    await render(false, null, async (host) => {
      assert.equal(host.querySelector('[role="group"]')?.getAttribute('aria-label'), 'Mode couleur');
      assert.equal(host.querySelector('[data-scheme="light"]')?.getAttribute('aria-label'), 'Clair');
    });
  } finally {
    await loadLocale('en');
  }
});
