/**
 * The interactive document card (MCPUI volet 4), mounted whole in jsdom: an
 * answer leaves only from a focus that came in legitimately under a user
 * gesture, a message only after the owner's click, a link only in `https:`,
 * and the full screen gives way to the agent's cards (ADR-MCPUI D5, D6, D11).
 */
import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';

const ID = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const EVENT = {
  id: ID, status: 'pending', title: 'Pick a plan', origin: { kind: 'agent', id: 'rooks.coder' },
  bridge: 'rooks', height: 240, expectsReply: true, createdAt: 1_760_000_000_000,
};

type Host = { awaitingUser: boolean; sent: Array<[string, string]> };

async function mount(options: { replyStatus?: number } = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><body><textarea id="composer"></textarea><div id="root"></div></body>', {
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
  const opened: string[] = [];
  Object.defineProperty(win, 'open', { configurable: true, value: (url: string) => { opened.push(url); return null; } });
  const posts: Array<{ url: string; body: unknown }> = [];
  install('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/ui/capabilities') return Response.json({ modules: [{ id: '@rooks/ui-documents', active: true }] });
    if (url === '/api/ui/plugins') return Response.json({ plugins: [] });
    if (init?.method === 'POST') {
      const body = init.body ? JSON.parse(String(init.body)) as unknown : null;
      posts.push({ url, body });
      if (url.endsWith('/reply')) {
        if (options.replyStatus) return Response.json({ error: 'not_found' }, { status: options.replyStatus });
        return Response.json({ document: { ...EVENT, status: 'answered', reply: (body as { reply: unknown }).reply }, delivered: true });
      }
      return Response.json({ document: { ...EVENT, status: 'dismissed' } });
    }
    if (url === `/api/ui/ui-documents/${ID}`) return Response.json({ document: { ...EVENT, reply: null }, deliverable: true });
    return new Response(null, { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  (await import('./plugin-host/slots')).resetSlotsForTests();
  (await import('./capabilities')).resetCapabilitiesCacheForTests();
  (await import('./plugin-host/loader')).resetClientPluginsForTests();
  const { uiDocumentsClient } = await import('../plugins-client/ui-documents');
  const { register } = await import('./plugin-host/slots');
  const { createClientRealtime } = await import('./plugin-host/realtime');
  uiDocumentsClient.apply({
    id: uiDocumentsClient.module,
    realtime: createClientRealtime(uiDocumentsClient.module, () => {}),
    caps: null,
    zoneVisible: () => true,
    options: {},
    register: (opts, Component) => register({ ...opts, pluginId: uiDocumentsClient.module }, Component),
    onDispose: () => {},
  });
  const { parseUiDocument } = await import('./ui-documents');
  const block = parseUiDocument(EVENT)!;
  const { ChatUiDocumentSlot, ChatDocumentHostProvider, setUserActivationProbe } = await import('../components/chat/ui-document-block');
  const { createRoot } = await import('react-dom/client');

  let gesture = false;
  setUserActivationProbe(() => gesture);
  const chat: Host = { awaitingUser: false, sent: [] };
  const container = document.createElement('div');
  document.getElementById('root')!.append(container);
  const root = createRoot(container);
  const paint = () => React.act(async () => {
    root.render(React.createElement(ChatDocumentHostProvider, {
      value: {
        awaitingUser: chat.awaitingUser,
        sendAsOwner: async (missionId: string, text: string) => { chat.sent.push([missionId, text]); return 'sent' as const; },
      },
    }, React.createElement(ChatUiDocumentSlot, { document: block, missionId: 'm-1' })));
  });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  await paint();
  await until(() => !!document.querySelector('iframe'), 'the document frame to mount');

  const iframe = () => document.querySelector('iframe')!;
  const button = (label: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) ?? null;
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  const out: Array<Record<string, unknown>> = [];
  Object.defineProperty(iframe().contentWindow!, 'postMessage', { configurable: true, value: (m: Record<string, unknown>) => out.push(m) });
  let nextId = 100;
  type Answer = { result?: Record<string, unknown>; error?: { code: number } } | undefined;
  const answerTo = (id: number): Answer => out.find((m) => m.id === id && !('method' in m)) as Answer;
  /** A request from the document, as its own window and its opaque origin send it; its id. */
  const post = async (method: string, params: Record<string, unknown>): Promise<number> => {
    const id = nextId++;
    await act(() => {
      win.dispatchEvent(new win.MessageEvent('message', { data: { jsonrpc: '2.0', id, method, params }, origin: 'null', source: iframe().contentWindow as never }));
    });
    return id;
  };
  const fromDocument = async (method: string, params: Record<string, unknown>): Promise<Answer> => {
    const id = await post(method, params);
    await until(() => answerTo(id) !== undefined, `an answer to ${method}`);
    return answerTo(id);
  };
  /** The same request, from another window or another origin: forged, it must be ignored. */
  const forged = (source: unknown, origin: string, method: string, params: Record<string, unknown>) => act(() => {
    win.dispatchEvent(new win.MessageEvent('message', { data: { jsonrpc: '2.0', id: nextId++, method, params }, origin, source: source as never }));
  });
  const enterLegitimately = () => act(() => button('Interact with the document')!.click());
  const steal = () => act(() => {
    const composer = document.getElementById('composer') as HTMLTextAreaElement;
    composer.focus();
    composer.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    iframe().focus();
  });
  const unmount = async () => {
    setUserActivationProbe(null);
    await React.act(async () => { root.unmount(); });
    win.close();
  };
  return {
    win, chat, opened, posts, out, iframe, button, act, until, paint, post, answerTo, fromDocument, forged, enterLegitimately, steal, unmount,
    setGesture: (on: boolean) => { gesture = on; },
  };
}

const submit = (value: unknown) => ['tools/call', { name: 'submit', arguments: value }] as const;

test('submit: refused without a gesture, refused after a stolen focus, sent from a legitimate entry', async () => {
  const m = await mount();
  await m.enterLegitimately();
  m.setGesture(false);
  assert.equal((await m.fromDocument(...submit({ plan: 'a' })))!.result!.isError, true, 'no user activation');
  assert.equal(m.posts.length, 0);

  await m.steal();
  m.setGesture(true);
  assert.equal((await m.fromDocument(...submit({ plan: 'a' })))!.result!.isError, true, 'the focus was stolen: it is not in the document');
  assert.equal(m.posts.length, 0);

  await m.enterLegitimately();
  const other = await m.fromDocument('tools/call', { name: 'deploy', arguments: {} });
  assert.equal(other!.error!.code, -32601, 'no other tool');
  const sent = await m.fromDocument(...submit({ plan: 'b' }));
  assert.deepEqual(sent!.result!.structuredContent, { status: 'answered' });
  assert.deepEqual(m.posts, [{ url: `/api/ui/ui-documents/${ID}/reply`, body: { reply: { plan: 'b' } } }]);
  assert.match(document.querySelector('[data-ui-document-answer]')?.textContent ?? '', /"plan": "b"/, 'the card shows what was sent');
  assert.equal((await m.fromDocument(...submit({ plan: 'c' })))!.result!.isError, true, 'one answer per document');
  assert.equal(m.posts.length, 1);
  await m.unmount();
});

test('submit: a neutralized card sends nothing, even under a gesture', async () => {
  const m = await mount();
  m.setGesture(true);
  for (let i = 0; i < 3; i++) await m.steal();
  assert.equal(m.iframe().hasAttribute('inert'), true);
  m.iframe().focus();
  assert.equal((await m.fromDocument(...submit({ plan: 'a' })))!.result!.isError, true);
  assert.equal(m.posts.length, 0);
  await m.unmount();
});

test('a refused reply leaves the card answerable and says so', async () => {
  const m = await mount({ replyStatus: 404 });
  m.setGesture(true);
  await m.enterLegitimately();
  assert.equal((await m.fromDocument(...submit({ plan: 'a' })))!.result!.isError, true);
  assert.match(document.body.textContent ?? '', /could not be sent/);
  assert.ok(document.querySelector('[data-ui-document-answer]') === null);
  await m.unmount();
});

test('ui/message: nothing leaves until the owner sends it; cancelled, nothing at all', async () => {
  const m = await mount();
  const message = (text: string) => m.post('ui/message', { role: 'user', content: [{ type: 'text', text }] });
  const cancelled = await message('Ship it');
  await m.until(() => !!document.querySelector('[role="alertdialog"]'), 'the message to be shown to the owner');
  assert.equal(m.answerTo(cancelled), undefined, 'waiting for the owner');
  assert.match(document.querySelector('[role="alertdialog"]')?.textContent ?? '', /Ship it/, 'the text is shown in clear');
  await m.act(() => m.button('Cancel')!.click());
  await m.until(() => m.answerTo(cancelled) !== undefined, 'the cancel to be answered');
  assert.deepEqual(m.answerTo(cancelled)!.result, { isError: true });
  assert.deepEqual(m.chat.sent, []);

  const accepted = await message('Use plan B');
  await m.until(() => !!m.button('Send'), 'the message to be shown to the owner');
  await m.act(() => m.button('Send')!.click());
  await m.until(() => m.answerTo(accepted) !== undefined, 'the sent message to be answered');
  assert.deepEqual(m.answerTo(accepted)!.result, {});
  assert.deepEqual(m.chat.sent, [['m-1', '[From the document "Pick a plan"] Use plan B']]);
  await m.unmount();
});

test('ui/open-link: https only, and only under a gesture in the document', async () => {
  const m = await mount();
  m.setGesture(true);
  await m.enterLegitimately();
  assert.deepEqual((await m.fromDocument('ui/open-link', { url: 'javascript:alert(document.cookie)' }))!.result, { isError: true });
  assert.deepEqual(m.opened, []);
  m.setGesture(false);
  assert.deepEqual((await m.fromDocument('ui/open-link', { url: 'https://example.com/' }))!.result, { isError: true });
  m.setGesture(true);
  assert.deepEqual((await m.fromDocument('ui/open-link', { url: 'https://example.com/' }))!.result, {});
  assert.deepEqual(m.opened, ['https://example.com/']);
  await m.unmount();
});

test('full screen: refused while the agent waits for the user; its way out comes first and gives the focus back', async () => {
  const m = await mount();
  m.setGesture(true);
  await m.enterLegitimately();
  m.chat.awaitingUser = true;
  await m.paint();
  assert.deepEqual((await m.fromDocument('ui/request-display-mode', { mode: 'fullscreen' }))!.result, { mode: 'inline' });
  assert.equal(m.button('Full screen')!.disabled, true);

  m.chat.awaitingUser = false;
  await m.paint();
  await m.enterLegitimately();
  const frameBefore = m.iframe();
  assert.deepEqual((await m.fromDocument('ui/request-display-mode', { mode: 'fullscreen' }))!.result, { mode: 'fullscreen' });
  const box = document.querySelector('[data-ui-document-box]')!;
  assert.match(box.className, /fixed inset-0/);
  assert.ok(m.iframe() === frameBefore, 'the same iframe: its state is kept');
  const exit = m.button('Exit full screen')!;
  assert.ok(box.contains(exit));
  assert.equal(exit.tabIndex, 0);
  assert.ok(exit.compareDocumentPosition(m.iframe()) & m.win.Node.DOCUMENT_POSITION_FOLLOWING, 'the way out comes before the document');
  await m.act(() => exit.click());
  // The card moves the focus on the next frame.
  await m.until(() => document.activeElement === m.button('Interact with the document'), 'the focus to return to the entry control');
  assert.doesNotMatch(document.querySelector('[data-ui-document-box]')!.className, /fixed/);
  assert.ok(document.activeElement === m.button('Interact with the document'), 'the focus returns to the entry control');

  // A card that waits for the user takes the screen back.
  await m.enterLegitimately();
  await m.fromDocument('ui/request-display-mode', { mode: 'fullscreen' });
  assert.match(document.querySelector('[data-ui-document-box]')!.className, /fixed/);
  m.chat.awaitingUser = true;
  await m.paint();
  await m.until(() => !/fixed/.test(document.querySelector('[data-ui-document-box]')!.className), 'the card to leave full screen');
  assert.doesNotMatch(document.querySelector('[data-ui-document-box]')!.className, /fixed/);
  await m.unmount();
});

test('full screen from the card\'s button puts the focus on the way out; Escape on the host leaves it', async () => {
  const m = await mount();
  await m.act(() => m.button('Full screen')!.click());
  await m.until(() => !!m.button('Exit full screen') && document.activeElement === m.button('Exit full screen'), 'the focus to move to the way out');
  assert.ok(document.activeElement === m.button('Exit full screen'), 'the focus is on the way out');
  await m.act(() => { document.activeElement!.dispatchEvent(new m.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  await m.until(() => document.activeElement === m.button('Interact with the document'), 'the focus to return to the entry control');
  assert.ok(m.button('Exit full screen') === null, 'out of full screen');
  assert.ok(document.activeElement === m.button('Interact with the document'), 'the focus returns to the entry control');
  await m.unmount();
});

test('close without answering: the card closes the document through the daemon', async () => {
  const m = await mount();
  await m.act(() => m.button('Close without answering')!.click());
  await m.until(() => m.posts.length > 0, 'the dismissal to reach the daemon');
  assert.deepEqual(m.posts.map((p) => p.url), [`/api/ui/ui-documents/${ID}/dismiss`]);
  await m.unmount();
});

test('a forged submit — another window, or a non-opaque origin — is ignored, not executed', async () => {
  const m = await mount();
  m.setGesture(true);
  await m.enterLegitimately();
  await m.forged(m.win, 'null', ...submit({ plan: 'forged' }));
  await m.forged(m.iframe().contentWindow, 'http://localhost', ...submit({ plan: 'forged' }));
  // Nothing to wait for when nothing may happen: a request taken would have
  // reached the fake daemon, and been answered, within this turn.
  await m.until(() => true, 'the forged requests to be dropped');
  assert.equal(m.posts.length, 0, 'nothing reached the daemon');
  assert.equal(m.out.length, 0, 'not even answered');
  await m.unmount();
});

test('in full screen, the message banner rises with the document; cancelled, nothing is sent', async () => {
  const m = await mount();
  m.setGesture(true);
  await m.enterLegitimately();
  await m.fromDocument('ui/request-display-mode', { mode: 'fullscreen' });
  const id = await m.post('ui/message', { role: 'user', content: [{ type: 'text', text: 'From full screen' }] });
  await m.until(() => !!document.querySelector('[role="alertdialog"]'), 'the message banner');
  const box = document.querySelector('[data-ui-document-box]')!;
  assert.match(box.className, /fixed/);
  const banner = document.querySelector('[role="alertdialog"]');
  assert.ok(banner && box.contains(banner), 'the banner is in the top-layer box, not left under it');
  await m.act(() => m.button('Cancel')!.click());
  await m.until(() => m.answerTo(id) !== undefined, 'the cancel to be answered');
  assert.deepEqual(m.answerTo(id)!.result, { isError: true });
  assert.deepEqual(m.chat.sent, []);
  await m.unmount();
});
