/**
 * TIM-0011 (3): the composer must not offer “Open a terminal” when the
 * daemon says the host cannot open one (`enabled: false`, typically
 * `reason: "no_gui"` on macOS/Windows).
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

const CWD = '/Users/luca';

function capabilities(active: boolean, builtIn?: boolean) {
  const modules: Array<Record<string, unknown>> = [{
    id: '@rooks/terminal-native',
    tier: 'opt',
    active,
    reason: active ? null : 'host capability unavailable: gui',
    missing: active ? [] : ['gui'],
  }];
  if (builtIn !== undefined) modules.push({ id: '@rooks/terminal-web', tier: 'opt', active: builtIn, reason: null, missing: [] });
  return {
    edition: 'expert',
    profile: 'macos',
    capabilities: active ? ['git'] : [],
    modules,
    ui: { hidden: [], home: '/' },
    kernel: true,
    developer: { unsignedPlugins: false },
  };
}

async function paint(ctx: TestContext, terminal: { enabled: boolean; reason?: string }, moduleActive: boolean, builtIn?: { module: boolean; enabled: boolean }): Promise<string> {
  const { JSDOM } = await import('jsdom');
  const { resetCapabilitiesCacheForTests } = await import('@/lib/capabilities');
  const { resetTerminalEnabledCacheForTests, TerminalButton } = await import('@/components/chat/composer');
  resetCapabilitiesCacheForTests();
  resetTerminalEnabledCacheForTests();
  // The terminal read waits for the conversation (`lib/load-priority.ts`).
  (await import('@/lib/load-priority')).markConversationShown();

  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');

  ctx.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/ui/terminal/web')) {
      // A daemon without the built-in terminal answers 404.
      if (!builtIn) return new Response(null, { status: 404 });
      return Response.json(builtIn.enabled ? { enabled: true, sessions: [] } : { enabled: false, reason: 'forbidden', sessions: [] });
    }
    if (url.includes('/api/ui/terminal') && !url.includes('/open')) {
      return Response.json({ enabled: terminal.enabled, command: 'hyper', ...(terminal.reason ? { reason: terminal.reason } : {}) });
    }
    if (url.includes('/api/ui/capabilities')) {
      return Response.json(capabilities(moduleActive, builtIn?.module));
    }
    return new Response(null, { status: 404 });
  });

  const root = createRoot(document.getElementById('root')!);
  try {
    await React.act(async () => {
      root.render(React.createElement(TerminalButton, { cwd: CWD, agent: { name: 'coder', project: null } }));
    });
    await React.act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    return document.body.innerHTML;
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('the terminal action is not offered when GET /api/ui/terminal is disabled', async (t) => {
  const html = await paint(t, { enabled: false, reason: 'no_gui' }, true);
  assert.equal(html.includes('Open a terminal'), false);
  assert.equal(html.includes('aria-label'), false);
});

test('the terminal action is offered when the host reports enabled', async (t) => {
  const html = await paint(t, { enabled: true }, true);
  assert.match(html, /aria-label="Open a terminal"/);
});

test('the terminal action stays hidden when the module is inactive even if GET lies', async (t) => {
  const html = await paint(t, { enabled: true }, false);
  assert.equal(html.includes('Open a terminal'), false);
});

test('the built-in terminal takes over the button, even on a host without gui', async (t) => {
  const html = await paint(t, { enabled: false, reason: 'no_gui' }, false, { module: true, enabled: true });
  assert.match(html, /aria-label="Open a terminal"/);
  assert.equal(html.includes('hidden'), false, 'offered on a phone too: it opens inside Rooks');
});

test('a user not allowed the built-in terminal falls back to the native rule', async (t) => {
  assert.equal((await paint(t, { enabled: false, reason: 'no_gui' }, false, { module: true, enabled: false })).includes('Open a terminal'), false);
  assert.match(await paint(t, { enabled: true }, true, { module: true, enabled: false }), /class="hidden[^"]*sm:grid/);
});

test('the built-in module switched off is never asked', async (t) => {
  const html = await paint(t, { enabled: false, reason: 'no_gui' }, false, { module: false, enabled: true });
  assert.equal(html.includes('Open a terminal'), false);
});
