import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';

test('workflow chat resizes with keyboard and pointer, persists, and fits a narrow workspace', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/workflows/witness' });
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('document', dom.window.document);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  let resize: (width: number) => void = () => {};
  install('ResizeObserver', class {
    constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) { resize = (width) => callback([{ contentRect: { width } }]); }
    observe() { resize(1400); }
    disconnect() {}
  });
  const originalFetch = globalThis.fetch;
  let layout: unknown = { width: 400 };
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/ui/auth/me') return Response.json({ user: { id: 'owner' } });
    assert.ok(String(input).startsWith('/api/ui/layout?scope='));
    if (init?.method === 'PUT') layout = JSON.parse(String(init.body)).layout;
    return Response.json({ layout });
  };
  const { createRoot } = await import('react-dom/client');
  const { PathnameContext, SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WorkspaceLayoutProvider } = await import('../components/workspace-layout-provider');
  const { WorkflowWorkspace } = await import('../plugins-client/workflows/workspace');
  const root = createRoot(document.getElementById('root')!);
  const render = async (open: boolean) => {
    await React.act(async () => {
      root.render(React.createElement(PathnameContext.Provider, { value: '/workflows/witness' },
        React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams() },
          React.createElement(WorkspaceLayoutProvider, { children: React.createElement(WorkflowWorkspace, { open, chat: 'Chat', children: [React.createElement('aside', { key: 'palette' }, 'Palette'), React.createElement('section', { key: 'canvas' }, 'Canvas')] }) }))));
    });
  };
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const handle = () => document.querySelector('[role="separator"]') as HTMLElement;
  const width = () => Number(handle().getAttribute('aria-valuenow'));
  const key = async (value: string) => { await React.act(async () => { handle().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true })); }); };
  try {
    await render(true);
    // The stored width arrives after chained reads (identity, then layout).
    await until(() => handle()?.getAttribute('aria-disabled') === 'false', 'the stored width to arm the handle');
    assert.equal(handle().getAttribute('aria-disabled'), 'false');
    assert.equal(width(), 400);
    await key('ArrowLeft');
    assert.equal(width(), 410);
    assert.deepEqual(layout, { width: 410 });
    await key('End');
    assert.equal(width(), 792);
    await key('Home');
    assert.equal(width(), 280);
    const separator = handle();
    separator.setPointerCapture = () => {};
    separator.releasePointerCapture = () => {};
    const pointer = async (type: string, x: number) => {
      await React.act(async () => {
        const event = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, button: 0 });
        Object.defineProperty(event, 'pointerId', { value: 1 });
        separator.dispatchEvent(event);
      });
    };
    await pointer('pointerdown', 1000);
    await pointer('pointermove', 850);
    assert.equal(width(), 430);
    assert.deepEqual(layout, { width: 280 }, 'drag frames do not write to storage');
    await pointer('pointerup', 850);
    assert.deepEqual(layout, { width: 430 });
    await render(false);
    await until(() => !document.querySelector('[role="separator"]'), 'the closed chat to drop its handle');
    assert.ok(!document.querySelector('[role="separator"]'));
    await render(true);
    await until(() => !!handle() && width() === 430, 'the reopened chat to keep its width');
    assert.equal(width(), 430);
    await React.act(async () => resize(360));
    assert.equal(width(), 360);
    assert.deepEqual(layout, { width: 430 }, 'viewport clamping preserves the preferred desktop width');
    await React.act(async () => resize(1400));
    assert.equal(width(), 430);
  } finally {
    await React.act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
    dom.window.close();
  }
});
