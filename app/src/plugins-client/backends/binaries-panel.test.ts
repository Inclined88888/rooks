/**
 * Settings › AI models › CLI binaries (TODO #413): the daemon's verdict is
 * painted as is, a path is sent trimmed, a refusal is a sentence of the
 * locale (never the path typed), Browse opens the desktop picker on this
 * computer's daemon and the daemon's own file browser otherwise (TODO #791),
 * and a refused list paints nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { binaryErrorMessage, binaryState, type BackendBinary } from '@/lib/backend-binaries';

const FOUND: BackendBinary = { cmd: 'claude', backends: ['claude'], path: '/usr/local/bin/claude', pinned: false, pin: null };
const MISSING: BackendBinary = { cmd: 'codex', backends: ['codex'], path: null, pinned: false, pin: null };

test('a binary state reads the pin before the detection', () => {
  assert.equal(binaryState(FOUND), 'found');
  assert.equal(binaryState(MISSING), 'missing');
  assert.equal(binaryState({ ...FOUND, pinned: true, pin: '/opt/claude' }), 'pinned');
  assert.equal(binaryState({ ...MISSING, pinned: true, pin: '/gone/codex' }), 'brokenPin');
});

test('daemon codes become sentences; an unknown one does not leak its message', () => {
  assert.match(binaryErrorMessage(400, 'path_not_executable'), /not executable/);
  assert.match(binaryErrorMessage(403, 'operator'), /superadmin/);
  assert.match(binaryErrorMessage(500, 'whatever'), /error 500/);
});

test('the panel lists, pins, refuses, browses and unpins', async (suite) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/settings', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver', 'Event']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { BinariesPanel } = await import('./binaries-panel');
  const originalFetch = globalThis.fetch;

  let list: BackendBinary[] = [FOUND, MISSING];
  let getStatus = 200;
  let refusePut: string | null = null;
  const requests: { method: string; url: string; body: unknown }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    requests.push({ method, url, body });
    if (method === 'GET' && url === '/api/ui/backends/binaries') {
      return getStatus === 200 ? Response.json({ binaries: list }) : Response.json({ error: 'unauthorized' }, { status: getStatus });
    }
    if (method === 'PUT' && url === '/api/ui/backends/binaries/codex') {
      if (refusePut) return Response.json({ error: refusePut, message: 'daemon text' }, { status: 400 });
      const path = (body as { path: string }).path;
      list = [FOUND, { ...MISSING, path, pinned: true, pin: path }];
      return Response.json({ binaries: list });
    }
    if (method === 'DELETE' && url === '/api/ui/backends/binaries/codex') {
      list = [FOUND, MISSING];
      return Response.json({ binaries: list });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  const root = createRoot(document.getElementById('root')!);
  const settle = async () => { await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const render = async () => {
    await React.act(async () => root.render(React.createElement(BinariesPanel)));
    await settle();
  };
  const input = (cmd: string) => document.getElementById(`binary-path-${cmd}`) as HTMLInputElement;
  const type = async (cmd: string, value: string) => {
    const field = input(cmd);
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
    await React.act(async () => {
      setter.call(field, value);
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const button = (label: RegExp, scope: ParentNode = document) =>
    Array.from(scope.querySelectorAll('button')).find((b) => label.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
  const row = (cmd: string) => input(cmd).closest('li')!;

  try {
    await suite.test('the daemon verdict is painted; Browse is offered in a plain browser too', async () => {
      await render();
      assert.match(row('claude').textContent!, /Runs \/usr\/local\/bin\/claude/);
      assert.match(row('claude').textContent!, /Found/);
      assert.match(row('codex').textContent!, /Not found/);
      assert.ok(button(/Browse/, row('codex')), 'the daemon lists its files where no OS dialog reaches it');
    });

    await suite.test('a refusal is a sentence of the locale, not the daemon text nor the path', async () => {
      refusePut = 'path_not_executable';
      await type('codex', '/secret/place/codex');
      await React.act(async () => { button(/Save path/, row('codex'))!.click(); });
      await settle();
      const alert = row('codex').querySelector('[role="alert"]')!;
      assert.match(alert.textContent!, /not executable/);
      assert.doesNotMatch(alert.textContent!, /daemon text|secret/);
      refusePut = null;
    });

    await suite.test('save sends the trimmed path and paints the new verdict', async () => {
      await type('codex', '  /opt/codex/bin/codex  ');
      await React.act(async () => { button(/Save path/, row('codex'))!.click(); });
      await settle();
      assert.deepEqual(requests.filter((r) => r.method === 'PUT').at(-1)!.body, { path: '/opt/codex/bin/codex' });
      assert.match(row('codex').textContent!, /Pinned/);
      assert.ok(button(/Remove pin/, row('codex')));
      assert.equal(button(/Remove pin/, row('claude')), undefined);
    });

    await suite.test('remove pin sends DELETE and goes back to detection', async () => {
      await React.act(async () => { button(/Remove pin/, row('codex'))!.click(); });
      await settle();
      assert.equal(requests.at(-1)!.method, 'DELETE');
      assert.match(row('codex').textContent!, /Not found/);
      assert.equal(input('codex').value, '');
    });

    await suite.test('with the desktop picker, Browse fills the field', async () => {
      await React.act(async () => root.render(React.createElement('div')));
      (dom.window as unknown as { timonDesktop: unknown }).timonDesktop = {
        restartAfterSetup: async () => undefined,
        selectExecutable: async () => '/Applications/Codex.app/Contents/Resources/codex',
      };
      await render();
      await React.act(async () => { button(/Browse/, row('codex'))!.click(); });
      await settle();
      assert.equal(input('codex').value, '/Applications/Codex.app/Contents/Resources/codex');
      delete (dom.window as unknown as { timonDesktop?: unknown }).timonDesktop;
    });

    await suite.test('a refused list paints nothing', async () => {
      await React.act(async () => root.render(React.createElement('div')));
      getStatus = 403;
      await render();
      assert.equal(document.getElementById('binaries-title'), null);
    });
  } finally {
    await React.act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
