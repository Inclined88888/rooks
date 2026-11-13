/**
 * The chat card of an HTML document (MCPUI volet 3), mounted whole in jsdom:
 * the sandbox, the source, the bridge's sender check, the card rebuilt from
 * the mission's event after a reload, and the focus rule (ADR-MCPUI D4.1).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const ID = '0b6f3c1e-2a4d-4e8f-9a1b-3c5d7e9f1a2b';
const EVENT = {
  id: ID, status: 'shown', title: 'Release checklist', origin: { kind: 'agent', id: 'rooks.coder' },
  bridge: 'rooks', height: 240, expectsReply: false, createdAt: 1_760_000_000_000,
};

type Mounted = Awaited<ReturnType<typeof mount>>;
type DomOptions = { view?: 'found' | 'expired' | 'failing'; status?: string; moduleOn?: boolean; plugins?: unknown[] };

/** A jsdom page and a daemon stub; the slot registry, capabilities and the
 *  client plugins start empty, as on a fresh page load. */
async function installDom(options: DomOptions = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><body><textarea id="composer"></textarea><div id="root"></div><button id="after">After</button></body>', {
    url: 'http://localhost/chat', pretendToBeVisual: true,
  });
  const win = dom.window;
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLIFrameElement', 'Element', 'Node', 'Event', 'MouseEvent',
    'KeyboardEvent', 'FocusEvent', 'MessageEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, key === 'window' ? win : (win as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(win, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  });
  const requests: string[] = [];
  install('fetch', async (input: string) => {
    const url = String(input);
    requests.push(url);
    if (url === '/api/ui/capabilities') {
      return Response.json({ modules: [{ id: '@rooks/ui-documents', active: options.moduleOn !== false }] });
    }
    if (url === '/api/ui/plugins') return Response.json({ plugins: options.plugins ?? [] });
    if (url === `/api/ui/ui-documents/${ID}`) {
      if (options.view === 'expired') return Response.json({ error: 'not_found' }, { status: 404 });
      if (options.view === 'failing') return Response.json({ error: 'unauthorized' }, { status: 401 });
      return Response.json({ document: { ...EVENT, status: options.status ?? 'shown' } });
    }
    return new Response(null, { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  const { resetSlotsForTests } = await import('./plugin-host/slots');
  resetSlotsForTests();
  const { resetCapabilitiesCacheForTests } = await import('./capabilities');
  resetCapabilitiesCacheForTests();
  const { resetClientPluginsForTests } = await import('./plugin-host/loader');
  resetClientPluginsForTests();
  // The product's card arrives with the bundled halves, as mountBundledClients
  // does it: only while the module runs.
  if (options.moduleOn !== false) await mountProductHalf();
  const { parseUiDocument } = await import('./ui-documents');
  const { ChatUiDocumentSlot } = await import('../components/chat/ui-document-block');
  const { createRoot } = await import('react-dom/client');

  const block = parseUiDocument({ ...EVENT, status: options.status ?? 'shown' });
  assert.ok(block);
  /** Mounts `count` cards of the document in a fresh root, as a conversation does. */
  const render = async (count = 1) => {
    const host = document.createElement('div');
    document.getElementById('root')!.append(host);
    const root = createRoot(host);
    await React.act(async () => {
      root.render(React.createElement(React.Fragment, null, ...Array.from({ length: count }, (_, i) =>
        React.createElement(ChatUiDocumentSlot, { key: i, document: block, missionId: 'm-1' }))));
    });
    // The capabilities and the view resolve on the next turns.
    for (let i = 0; i < 3; i++) await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    return async () => { await React.act(async () => { root.unmount(); }); host.remove(); };
  };
  return { win, React, requests, render };
}

async function mountProductHalf(): Promise<void> {
  const { uiDocumentsClient } = await import('../plugins-client/ui-documents');
  const { register } = await import('./plugin-host/slots');
  const { createClientRealtime } = await import('./plugin-host/realtime');
  const id = uiDocumentsClient.module;
  uiDocumentsClient.apply({
    id,
    realtime: createClientRealtime(id, () => {}),
    caps: null,
    zoneVisible: () => true,
    options: {},
    register: (options, Component) => register({ ...options, pluginId: id }, Component),
    onDispose: () => {},
  });
}

async function mount(options: DomOptions = {}) {
  const { win, React, requests, render } = await installDom(options);
  const close = await render();
  const iframe = () => document.querySelector('iframe');
  const entry = () => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Interact with the document') ?? null;
  const act = (fn: () => void) => React.act(async () => { fn(); });
  const unmount = async () => { await close(); win.close(); };
  return { win, iframe, entry, act, requests, unmount };
}

async function steal(m: Mounted) {
  const composer = document.getElementById('composer') as HTMLTextAreaElement;
  await m.act(() => {
    composer.focus();
    composer.dispatchEvent(new m.win.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    m.iframe()!.focus();
  });
  return composer;
}

test('the iframe is sandboxed without allow-same-origin and loads the Rooks route only', async () => {
  const m = await mount();
  const frame = m.iframe();
  assert.ok(frame, 'the document is shown');
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts allow-forms');
  const tokens = frame.getAttribute('sandbox')!.split(/\s+/);
  for (const forbidden of ['allow-same-origin', 'allow-popups', 'allow-top-navigation', 'allow-modals', 'allow-downloads']) {
    assert.equal(tokens.includes(forbidden), false, forbidden);
  }
  assert.equal(frame.getAttribute('src'), `/api/ui/ui-documents/${ID}/document`);
  assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(frame.style.height, '240px');
  await m.unmount();
});

test('the card is a named group; the entry control comes before the iframe and gives it the focus', async () => {
  const m = await mount();
  const frame = m.iframe()!;
  assert.equal(frame.getAttribute('title'), 'Release checklist');
  const group = frame.closest('[role="group"]')!;
  assert.ok(group);
  assert.equal(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent, 'Release checklist');
  const entry = m.entry()!;
  assert.ok(entry);
  assert.equal(entry.tabIndex, 0);
  assert.ok(entry.compareDocumentPosition(frame) & m.win.Node.DOCUMENT_POSITION_FOLLOWING, 'entry control before the iframe');
  await m.act(() => entry.click());
  assert.equal(document.activeElement, frame);
  await m.unmount();
});

test('the bridge answers the iframe\'s own window only, from an opaque origin only', async () => {
  const m = await mount();
  const frame = m.iframe()!;
  const posted: unknown[] = [];
  Object.defineProperty(frame.contentWindow!, 'postMessage', { configurable: true, value: (message: unknown) => posted.push(message) });
  const send = (source: unknown, origin: string, id: number) => m.act(() => {
    m.win.dispatchEvent(new m.win.MessageEvent('message', { data: { jsonrpc: '2.0', id, method: 'ping' }, origin, source: source as never }));
  });
  await send(m.win, 'null', 1);
  await send(frame.contentWindow, 'http://localhost', 2);
  assert.deepEqual(posted, []);
  await send(frame.contentWindow, 'null', 3);
  assert.deepEqual(posted, [{ jsonrpc: '2.0', id: 3, result: {} }]);
  // The parent itself is never reachable by the document: no same-origin, so no window.parent.document.
  assert.equal(frame.getAttribute('sandbox')!.includes('allow-same-origin'), false);
  await m.unmount();
});

test('after a reload the card is rebuilt from the event, its view read before the iframe mounts', async () => {
  const answered = await mount({ status: 'answered' });
  assert.ok(answered.requests.includes(`/api/ui/ui-documents/${ID}`), 'the view is read before the iframe');
  assert.ok(document.querySelector('[data-ui-document="answered"]'));
  assert.match(document.body.textContent ?? '', /answered/);
  assert.ok(answered.iframe());
  await answered.unmount();

  const expired = await mount({ view: 'expired' });
  assert.ok(!expired.iframe(), 'a purged document never mounts an iframe');
  assert.match(document.body.textContent ?? '', /no longer kept/);
  await expired.unmount();

  // A refused or failing read never mounts it either: its JSON would paint inside the card.
  const failing = await mount({ view: 'failing' });
  assert.ok(!failing.iframe());
  assert.match(document.body.textContent ?? '', /could not be loaded/);
  await failing.unmount();

  const dismissed = await mount({ status: 'dismissed' });
  assert.ok(!dismissed.iframe());
  assert.match(document.body.textContent ?? '', /was closed/);
  await dismissed.unmount();
});

test('module switched off: the card says so and shows no document', async () => {
  const m = await mount({ moduleOn: false });
  assert.ok(!m.iframe());
  assert.match(document.body.textContent ?? '', /switched off/);
  await m.unmount();
});

test('a stolen focus goes back to the composer with an announcement; the third theft makes the iframe inert until reactivated', async () => {
  const m = await mount();
  const composer = await steal(m);
  assert.equal(document.activeElement, composer);
  const live = document.querySelector('[aria-live="polite"]')!;
  assert.match(live.textContent ?? '', /tried to take the focus/);
  await steal(m);
  assert.equal(m.iframe()!.hasAttribute('inert'), false);
  await steal(m);
  assert.equal(document.activeElement, composer);
  assert.equal(m.iframe()!.hasAttribute('inert'), true);
  const reactivate = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Reactivate')!;
  assert.ok(reactivate);
  await m.act(() => reactivate.click());
  assert.equal(m.iframe()!.hasAttribute('inert'), false);
  assert.equal(document.activeElement, m.entry());
  await m.unmount();
});

test('a replacement loaded before any card keeps the slot while every card leaves and comes back', async () => {
  const { win, React, render } = await installDom({
    plugins: [{ id: 'acme-doc', state: 'active', client: { url: '/x', rev: '1', slots: ['chat.document'] } }],
  });
  const { useUiDocument } = await import('../components/chat/ui-document-block');
  const { slotEntries } = await import('./plugin-host/slots');
  const loader = await import('./plugin-host/loader');
  const AcmeCard = () => React.createElement('p', { 'data-acme': '' }, useUiDocument()?.document.title);
  loader.setLoadClientModuleForTests(async () => ({
    apply(ctx) { ctx.slots.register({ slot: 'chat.document' }, AcmeCard); },
  }));
  const occupants = () => slotEntries('chat.document').map((e) => e.pluginId);
  try {
    // The real boot order: the plugins load before any document is on screen.
    await loader.syncClientPlugins();
    assert.deepEqual(occupants(), ['acme-doc', '@rooks/ui-documents']);

    const closeTwo = await render(2);
    assert.equal(document.querySelectorAll('[data-acme]').length, 2);
    assert.equal(document.querySelector('[data-acme]')!.textContent, 'Release checklist');
    assert.ok(!document.querySelector('iframe'), 'the product card steps aside');
    await closeTwo();
    assert.deepEqual(occupants(), ['acme-doc', '@rooks/ui-documents'], 'the last card leaving collapses nothing');

    const closeOne = await render(1);
    assert.equal(document.querySelectorAll('[data-acme]').length, 1);
    assert.ok(!document.querySelector('iframe'));
    await closeOne();
  } finally {
    loader.setLoadClientModuleForTests(null);
    loader.resetClientPluginsForTests();
    win.close();
  }
});

test('without a replacement, the product card occupies the boot slot', async () => {
  const { win, render } = await installDom();
  const { slotEntries, slotKind } = await import('./plugin-host/slots');
  assert.equal(slotKind('chat.document'), 'single', 'declared at boot, before any card');
  assert.deepEqual(slotEntries('chat.document').map((e) => e.pluginId), ['@rooks/ui-documents']);
  const close = await render(1);
  assert.ok(document.querySelector('iframe'));
  await close();
  win.close();
});
