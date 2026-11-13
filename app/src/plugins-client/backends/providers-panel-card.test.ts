import assert from 'node:assert/strict';
import test from 'node:test';
import { waitUntil } from '@/lib/test-wait';

/**
 * A refused third-party launch raises a card (`provider-launch:<id>`, TODO #598) that opens
 * Settings › AI models › Backends with `?provider=<id>`. Mounts the real `ProvidersPanel` and checks
 * what the operator can do there: the authorization dialog opens on the paths the daemon resolved and
 * authorizes nothing until confirmed, a provider with nothing to authorize opens no dialog, and the
 * parameter is dropped so Back does not reopen it. The daemon's refusal of anyone but a superadmin
 * signed in to the app is covered by `provider-routes.test.ts`.
 */
test('the refused launch card opens the re-authorization dialog, which allows nothing before its confirm', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/?settings=models%2Fbackends&provider=acme', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'NodeFilter', 'HTMLInputElement', 'SVGElement', 'Event', 'CustomEvent', 'FocusEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const moved = '/home/u/.local/share/acme/2.0.0/acme-agent';
  let providers = [
    {
      id: 'acme', label: 'Acme agent', version: '1.0.0', state: 'active', reason: null, error: null, signed: true,
      binaries: [{ name: 'acme-agent', found: 'acme-agent', resolved: moved, allowed: false, refused: null }], backends: ['acme-profile'],
    },
    {
      id: 'beta', label: 'Beta agent', version: '1.0.0', state: 'active', reason: null, error: null, signed: true,
      binaries: [{ name: 'beta-agent', found: 'beta-agent', resolved: '/usr/bin/beta-agent', allowed: true, refused: null }], backends: ['beta'],
    },
  ];
  const posts: { url: string; body: unknown }[] = [];
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      providers = providers.map((p) => (p.id === 'acme' ? { ...p, binaries: p.binaries.map((b) => ({ ...b, allowed: true })) } : p));
      return Response.json({ granted: [moved] });
    }
    if (url === '/api/ui/providers/list') return Response.json({ providers });
    return Response.json({});
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { ProvidersPanel } = await import('./providers-panel');

  const root = createRoot(document.getElementById('root')!);
  const render = (search: string) => React.act(async () => {
    root.render(React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) as never },
      React.createElement(ProvidersPanel)));
  });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const dialog = () => document.querySelector('[role="dialog"]');
  const confirm = () => Array.from(dialog()?.querySelectorAll('button') ?? []).find((b) => b.textContent === 'Allow these programs');
  const click = (el: Element) => React.act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });

  try {
    await render('settings=models%2Fbackends&provider=acme');
    await until(() => confirm() !== undefined, 'the authorization dialog to open on the named provider');
    assert.match(dialog()!.textContent ?? '', /Acme agent/);
    assert.ok((dialog()!.textContent ?? '').includes(moved), 'the dialog shows the path the daemon resolved');
    assert.equal(posts.length, 0, 'opening the card authorizes nothing');
    assert.equal(new URL(window.location.href).searchParams.get('provider'), null, 'the request is consumed: Back does not reopen it');
    assert.equal(new URL(window.location.href).searchParams.get('settings'), 'models/backends', 'Settings stays open where it was');

    await click(confirm()!);
    await until(() => posts.length === 1 && dialog() === null, 'the authorization to be sent and the dialog closed');
    assert.deepEqual(posts[0], { url: '/api/ui/providers/acme/authorize', body: { paths: [moved] } });

    // A provider with nothing to authorize (already done, or another cause): no dialog, the row is pointed at.
    await render('settings=models%2Fbackends&provider=beta');
    await until(() => document.querySelector('[data-provider="beta"]')?.className.includes('ring-1') === true, 'the row to be pointed at');
    assert.equal(dialog(), null);

    // An id the daemon does not list opens nothing either.
    await render('settings=models%2Fbackends&provider=nobody');
    await until(() => dialog() === null, 'no dialog for an unknown provider');
    assert.equal(posts.length, 1, 'nothing else was authorized');
  } finally {
    await React.act(async () => { root.unmount(); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
