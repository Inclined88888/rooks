import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as protocol from './native-browser-protocol.js';
import * as credentials from './native-browser-credentials.js';
import * as recorder from './native-browser-recorder.js';
import * as annotator from './native-browser-annotator.js';
import * as bubbleRules from './native-browser-bubble.js';

/** The engine's annotate mode (TODO #468), driven without Electron: fake tabs, a scripted CDP. */

const nodeRequire = createRequire(import.meta.url);
const source = (await readFile(new URL('./native-browser.ts', import.meta.url), 'utf8'))
  .replaceAll('import.meta.url', JSON.stringify(new URL('./native-browser.ts', import.meta.url).href));
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const {
  BROWSER_ANNOTATE_EVENT_CHANNEL: EVENT, BROWSER_ANNOTATE_STATE_CHANNEL: STATE, BROWSER_ANNOTATE_TOGGLE_CHANNEL: TOGGLE,
  BROWSER_ANNOTATE_PICK_AT_CHANNEL: PICK_AT,
} = protocol;
const human = { commandActor: 'human' };

interface FakeImage { width: number; height: number; bytes: number }
interface FakeContents {
  url: string; title: string; sent: unknown[][]; mainFrame: object; destroyed: boolean; captures: unknown[];
  image: FakeImage | null; onSend: ((channel: string, value: unknown) => void) | null;
  getURL(): string; getTitle(): string; isDestroyed(): boolean; send(channel: string, value: unknown): void; close(): void; focus(): void;
  capturePage(rect: unknown): Promise<unknown>;
  navigationHistory: { canGoBack(): boolean; canGoForward(): boolean };
}

function nativeImageOf(image: FakeImage): unknown {
  return {
    isEmpty: () => image.width === 0,
    getSize: () => ({ width: image.width, height: image.height }),
    resize: ({ width, height }: { width: number; height: number }) => nativeImageOf({ width, height, bytes: Math.round(image.bytes * width / image.width) }),
    toJPEG: (quality: number) => Buffer.alloc(Math.round(image.bytes * quality / 100), 1),
  };
}

function contentsAt(url: string): FakeContents {
  const contents: FakeContents = {
    url, title: 'Shop\u0007 — cart', sent: [], mainFrame: {}, destroyed: false, captures: [], image: { width: 168, height: 78, bytes: 20_000 },
    onSend: null,
    getURL: () => contents.url, getTitle: () => contents.title, isDestroyed: () => contents.destroyed,
    send: (channel, value) => { contents.sent.push([channel, value]); contents.onSend?.(channel, value); },
    close: () => { contents.destroyed = true; },
    focus: () => {},
    capturePage: async (rect) => { contents.captures.push(rect); return contents.image ? nativeImageOf(contents.image) : new Promise(() => {}); },
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  };
  return contents;
}

/** What `Runtime.getProperties` lists for each handle: a React 18 button by default. */
const REACT18: Record<string, unknown[]> = {
  node: [{ name: '__reactFiber$x', value: { type: 'object', objectId: 'fiber' } }],
  fiber: [{ name: '_debugSource', value: { type: 'object', objectId: 'source' } }, { name: '_debugOwner', value: { type: 'object', objectId: 'owner' } }],
  source: [{ name: 'fileName', value: { type: 'string', value: '/home/dev/app/src/Cart.jsx' } }, { name: 'lineNumber', value: { type: 'number', value: 12 } }],
  owner: [{ name: 'type', value: { type: 'function', objectId: 'cart' } }],
  cart: [{ name: 'name', value: { type: 'string', value: 'Cart' } }],
};

/** The bubble's views, recorded: the real ones are Electron's (native-browser-annotation-overlay.ts). */
class FakeOverlay {
  static last: FakeOverlay | null = null;
  readonly calls: unknown[][] = [];
  readonly contents = { mainFrame: {}, isFocused: () => false, focus: () => {} };
  constructor() { FakeOverlay.last = this; }
  get bubbleContents() { return this.contents; }
  isBubbleSender(event: { sender: unknown; senderFrame: unknown }) { return event.sender === this.contents && event.senderFrame === this.contents.mainFrame; }
  bubbleReady() { this.calls.push(['ready']); }
  attach() { this.calls.push(['attach']); }
  detach() { this.calls.push(['detach']); }
  raise() {}
  showBubble(bounds: unknown, show: unknown) { this.calls.push(['show', JSON.parse(JSON.stringify(show)), bounds]); }
  updateBubble(state: unknown) { this.calls.push(['update', JSON.parse(JSON.stringify(state))]); }
  moveBubble() {}
  hideBubble() { this.calls.push(['hide']); }
  setPins(pins: unknown) { this.calls.push(['pins', JSON.parse(JSON.stringify(pins))]); }
  movePin() {}
  close() { this.calls.push(['close']); }
}

function fixture(options: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {};
  const ipcMain = new EventEmitter();
  runInNewContext(compiled, {
    exports, console, Buffer, URL, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    require: (name: string) => name === 'electron' ? { ipcMain }
      : name === './native-browser-protocol.js' ? protocol
        : name === './native-browser-credentials.js' ? credentials
          : name === './native-browser-recorder.js' ? recorder
            : name === './native-browser-annotator.js' ? annotator
              : name === './native-browser-bubble.js' ? bubbleRules
                : name === './native-browser-annotation-overlay.js' ? { AnnotationOverlay: FakeOverlay } : nodeRequire(name),
  });
  const engine = new exports.NativeBrowserEngine('/unused', options);
  const tabs = {
    a: { id: 'tab-a', view: { webContents: contentsAt('https://shop.test/cart?session=abc123&lang=fr') } },
    b: { id: 'tab-b', view: { webContents: contentsAt('https://shop.test/b') } },
  };
  const profile = { id: 'profile-a', dialogs: new Map(), tabs: new Map(Object.values(tabs).map((tab) => [tab.id, tab])),
    activeTabId: 'tab-a', viewport: { width: 640, height: 480, mobile: false }, fileChooser: null, permissions: new Map(),
    downloads: new Map(), contextMenu: null, audioMuted: true, stopping: false, recording: null, recordingTimer: null,
    annotation: null, annotationTimer: null, annotationPicks: [], annotationCapturing: 0, annotationWork: Promise.resolve(),
    annotationWaiters: new Map(), bubble: null, overlay: null, bubbleAnchors: new Map(), pwaPins: new Map(), pwaFollowed: [] };
  engine.profiles.set(profile.id, profile);
  const cdpCalls: Array<[string, Record<string, unknown> | undefined]> = [];
  const page = { properties: REACT18 as Record<string, unknown[]>, nodeName: 'BUTTON', scroll: { pageX: 0, pageY: 300 } };
  engine.cdp = async (_tab: unknown, method: string, params?: Record<string, unknown>) => {
    // Built in the vm realm: kept as plain data.
    cdpCalls.push([method, params && JSON.parse(JSON.stringify(params))]);
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: page.scroll };
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: 7 };
    if (method === 'DOM.describeNode') return { node: { nodeName: page.nodeName } };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'node' } };
    if (method === 'Runtime.getProperties') return { result: page.properties[String(params?.objectId)] ?? [] };
    return {};
  };
  engine.presentActive = () => {};
  engine.saveTabs = () => {};
  engine.removeView = () => {};
  // Results are built in the vm realm: compare them as plain data.
  const command = async (action: string, body: Record<string, unknown> = {}) =>
    JSON.parse(JSON.stringify(await engine.command({ profileId: profile.id, action, ...body }) ?? null));
  const ipc = (channel: string, contents: FakeContents, payload?: unknown, frame: object = contents.mainFrame) => {
    const event: { sender: FakeContents; senderFrame: object; returnValue?: unknown } = { sender: contents, senderFrame: frame };
    ipcMain.emit(channel, event, payload);
    return event;
  };
  const settle = async () => { await profile.annotationWork; await new Promise((resolve) => setImmediate(resolve)); };
  const methods = () => cdpCalls.map(([method]) => method);
  const close = async () => { engine.queues.clear(); engine.profiles.clear(); await engine.close(); };
  /** As the app presents the panel: a window, its rectangle, the conversation it is open for. */
  const present = (conversation: unknown = { agent: 'rooks.coder', mission: null }) => {
    engine.presentations.set(profile.id, { profileId: profile.id, window: { isDestroyed: () => false, isFocused: () => false, contentView: { children: [] } },
      bounds: { x: 100, y: 40, width: 640, height: 480 }, conversation, locale: 'fr', scheme: 'light' });
  };
  return { engine, profile, tabs, command, ipc, cdpCalls, methods, page, settle, close, present };
}

const refused = (status: number) => (error: unknown) => error instanceof protocol.BrowserCommandError && error.statusCode === status;

const pick = (extra: Record<string, unknown> = {}) => ({
  type: 'pick', point: { x: 50, y: 40 }, rect: { x: 20, y: 30, width: 120, height: 30 }, viewport: { width: 640, height: 480 },
  scroll: { x: 0, y: 300 }, tag: 'button', role: 'button', name: 'Checkout', text: 'Checkout', inputType: '', autocomplete: '',
  selector: 'button#checkout', xpath: '/html[1]/body[1]/button[1]', id: 'checkout', classes: ['cta'],
  outerHtml: '<button id="checkout" class="cta">Checkout</button>', ...extra,
});

test('only the user starts, stops, picks or collects; anyone reads the state', { timeout: 2000 }, async () => {
  const { command, profile, close } = fixture();
  try {
    for (const action of ['annotateStart', 'annotateStop', 'annotatePick', 'annotateCollect', 'annotateHighlight', 'annotateUnpin', 'annotatePins']) {
      await assert.rejects(command(action, { x: 1, y: 1 }), refused(403), action);
      await assert.rejects(command(action, { x: 1, y: 1, commandActor: 'agent' }), refused(403), action);
    }
    assert.equal(profile.annotation, null);
    await command('annotateStart', human);
    assert.deepEqual((await command('status')).annotation, { active: true, tabId: 'tab-a', pending: 0, queued: 0, capturing: 0 }, 'no ids without a queue');
  } finally { await close(); }
});

test('starting turns on the active tab only, with the highlight domains, and refuses a second start', { timeout: 2000 }, async () => {
  const { command, tabs, methods, cdpCalls, close } = fixture();
  try {
    await command('annotateStart', human);
    assert.deepEqual(tabs.a.view.webContents.sent, [[TOGGLE, true]]);
    assert.deepEqual(tabs.b.view.webContents.sent, []);
    assert.deepEqual(methods(), ['DOM.enable', 'Overlay.enable', 'Overlay.setShowViewportSizeOnResize']);
    assert.deepEqual(cdpCalls[2]![1], { show: false });
    await assert.rejects(command('annotateStart', human), refused(409));
  } finally { await close(); }
});

test('annotating and recording exclude each other', { timeout: 2000 }, async () => {
  const { command, close } = fixture();
  try {
    await command('recordStart', human);
    await assert.rejects(command('annotateStart', human), refused(409));
    await command('recordStop', human);
    await command('annotateStart', human);
    await assert.rejects(command('recordStart', human), refused(409));
  } finally { await close(); }
});

test('while the user annotates, the agent cannot move the page; the user can, and reads stay open', { timeout: 2000 }, async () => {
  const { command, methods, cdpCalls, close } = fixture();
  try {
    await command('annotateStart', human);
    cdpCalls.length = 0;
    for (const [action, body] of [['input', { event: { type: 'click', x: 50, y: 40 } }], ['input', { event: { type: 'key', key: 'Enter' } }],
      ['navigate', { url: 'https://x.test/' }], ['evaluate', { expression: '1' }], ['clipboardPaste', { text: 'x' }],
      ['newTab', {}], ['activateTab', { tabId: 'tab-b' }], ['closeTab', { tabId: 'tab-a' }], ['reload', {}],
      ['fillCredential', { origin: 'https://shop.test' }], ['stop', {}], ['resize', { width: 800, height: 600, mobile: false }]] as const) {
      await assert.rejects(command(action, body), refused(409), action);
      await assert.rejects(command(action, { ...body, commandActor: 'agent' }), refused(409), action);
    }
    assert.deepEqual(methods(), [], 'no agent gesture reached the page');
    assert.equal((await command('status')).annotation.active, true);
    await command('input', { event: { type: 'click', x: 50, y: 40 }, ...human });
    assert.deepEqual(methods(), ['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent'], 'the user still drives');
  } finally { await close(); }
});

test('a command queued before annotate mode started is refused when it runs', { timeout: 2000 }, async () => {
  const { engine, profile, command, methods, close } = fixture();
  let release!: () => void;
  engine.queues.set(profile.id, new Promise<void>((resolve) => { release = resolve; }));
  try {
    const queued = command('input', { event: { type: 'click', x: 1, y: 1 } });
    (profile as { annotation: unknown }).annotation = new annotator.AnnotationSession('tab-a');
    release();
    await assert.rejects(queued, refused(409));
    assert.deepEqual(methods(), []);
  } finally { await close(); }
});

test('only the annotated tab main frame is told to annotate, and only it is heard', { timeout: 2000 }, async () => {
  const { command, ipc, tabs, profile, methods, settle, close } = fixture();
  const stranger = contentsAt('https://evil.test/');
  try {
    assert.equal(ipc(STATE, tabs.a.view.webContents).returnValue, false);
    ipc(EVENT, tabs.a.view.webContents, pick());
    await command('annotateStart', human);
    assert.equal(ipc(STATE, tabs.a.view.webContents).returnValue, true);
    assert.equal(ipc(STATE, tabs.b.view.webContents).returnValue, false, 'another tab of the profile');
    assert.equal(ipc(STATE, tabs.a.view.webContents, undefined, {}).returnValue, false, 'a sub-frame');
    assert.equal(ipc(STATE, stranger).returnValue, false, 'an unknown sender still gets an answer, never true');
    const before = methods().length;
    ipc(EVENT, tabs.b.view.webContents, pick());
    ipc(EVENT, tabs.a.view.webContents, pick(), {});
    ipc(EVENT, stranger, pick());
    ipc(EVENT, tabs.a.view.webContents, pick({ outerHtml: 'x'.repeat(30_000) }));
    ipc(EVENT, tabs.a.view.webContents, { ...pick(), tag: 42 });
    ipc(EVENT, tabs.a.view.webContents, { type: 'hover', tag: 'div', rect: 'nope' });
    await settle();
    assert.deepEqual(profile.annotationPicks, []);
    assert.equal(methods().length, before, 'nothing from a refused sender reached CDP');
  } finally { await close(); }
});

test('a pick from the native view is captured without running page code, and waits to be collected', { timeout: 2000 }, async () => {
  const { command, ipc, tabs, methods, cdpCalls, settle, close } = fixture();
  try {
    await command('annotateStart', human);
    cdpCalls.length = 0;
    ipc(EVENT, tabs.a.view.webContents, pick({ text: 'Checkout\u0000 now' }));
    await settle();
    assert.equal((await command('status')).annotation.pending, 1);
    for (const forbidden of ['Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.enable', 'Page.captureScreenshot']) {
      assert.ok(!methods().includes(forbidden), forbidden);
    }
    const located = cdpCalls.find(([method]) => method === 'DOM.getNodeForLocation')![1];
    assert.deepEqual(located, { x: 50, y: 340, includeUserAgentShadowDOM: false }, 'document coordinates: the point plus the scroll');
    assert.ok(cdpCalls.filter(([method]) => method === 'Runtime.getProperties')
      .every(([, params]) => params?.ownProperties === true && params.generatePreview === false));
    assert.ok(methods().includes('Runtime.releaseObjectGroup'));
    assert.deepEqual(tabs.a.view.webContents.captures, [{ x: 0, y: 6, width: 164, height: 78 }]);
    const { annotation } = await command('annotateCollect', human);
    assert.equal(annotation.picks.length, 1);
    const [capture] = annotation.picks;
    assert.equal(capture.version, 1);
    assert.equal(capture.url, 'https://shop.test/cart?session={SECRET:session}&lang=fr');
    assert.equal(capture.title, 'Shop — cart');
    assert.equal(capture.tabId, 'tab-a');
    assert.equal(capture.target.text, 'Checkout now');
    assert.deepEqual(capture.source, { detected: true, framework: 'react', file: '/home/dev/app/src/Cart.jsx', line: 12,
      component: 'Cart', via: 'debugSource' });
    assert.equal(capture.thumbnail.mimeType, 'image/jpeg');
    assert.deepEqual([capture.thumbnail.width, capture.thumbnail.height], [168, 78]);
    assert.ok(!JSON.stringify(capture).includes('abc123'));
    assert.deepEqual((await command('annotateCollect', human)).annotation.picks, [], 'collecting drains');
  } finally { await close(); }
});

test('a hostile page: a Proxy fiber is refused, a changed element is not attributed', { timeout: 2000 }, async () => {
  const { command, ipc, tabs, page, cdpCalls, settle, close } = fixture();
  try {
    await command('annotateStart', human);
    page.properties = { node: [{ name: '__reactFiber$h', value: { type: 'object', subtype: 'proxy', objectId: 'fiber' } }], fiber: REACT18.fiber! };
    cdpCalls.length = 0;
    ipc(EVENT, tabs.a.view.webContents, pick());
    await settle();
    assert.deepEqual(cdpCalls.filter(([method]) => method === 'Runtime.getProperties').map(([, params]) => params?.objectId), ['node']);
    page.properties = REACT18;
    page.nodeName = 'DIV';
    await new Promise((resolve) => setTimeout(resolve, 420));
    ipc(EVENT, tabs.a.view.webContents, pick());
    await settle();
    const picks = (await command('annotateCollect', human)).annotation.picks;
    assert.deepEqual(picks.map((capture: { source: unknown }) => capture.source), [{ detected: false }, { detected: false }]);
  } finally { await close(); }
});

test('a secret field picked ships neither its text nor its markup', { timeout: 2000 }, async () => {
  const { command, ipc, tabs, settle, close } = fixture();
  try {
    await command('annotateStart', human);
    ipc(EVENT, tabs.a.view.webContents, pick({ tag: 'input', inputType: 'password', role: 'textbox', name: 'Password',
      text: 'hunter2', outerHtml: '<input type="password" value="hunter2">' }));
    await settle();
    const [capture] = (await command('annotateCollect', human)).annotation.picks;
    assert.deepEqual([capture.target.text, capture.outerHtml], ['', '']);
    assert.ok(!JSON.stringify(capture).includes('hunter2'));
  } finally { await close(); }
});

test('the thumbnail is bounded: none off screen, none when too heavy, downscaled when large', { timeout: 2000 }, async () => {
  const { command, ipc, tabs, settle, close } = fixture();
  const contents = tabs.a.view.webContents;
  try {
    await command('annotateStart', human);
    ipc(EVENT, contents, pick({ rect: { x: 20, y: 900, width: 100, height: 30 } }));
    await settle();
    contents.image = { width: 640, height: 480, bytes: 2_000_000 };
    await new Promise((resolve) => setTimeout(resolve, 420));
    ipc(EVENT, contents, pick());
    await settle();
    const picks = (await command('annotateCollect', human)).annotation.picks;
    assert.deepEqual(picks.map((capture: { thumbnail?: unknown }) => capture.thumbnail ?? null), [null, null]);
    assert.equal(contents.captures.length, 1, 'an element out of view is not captured at all');
  } finally { await close(); }
});

test('hover highlights the element inside the viewport, in integer CSS pixels', { timeout: 2000 }, async () => {
  const { command, ipc, tabs, cdpCalls, close } = fixture();
  try {
    await command('annotateStart', human);
    cdpCalls.length = 0;
    ipc(EVENT, tabs.a.view.webContents, { type: 'hover', tag: 'div', rect: { x: -10.5, y: 470.2, width: 100, height: 40 } });
    ipc(EVENT, tabs.a.view.webContents, { type: 'hover', tag: 'div', rect: { x: 10, y: 900, width: 100, height: 40 } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cdpCalls.map(([method, params]) => [method, params && { x: params.x, y: params.y, width: params.width, height: params.height }]),
      [['Overlay.highlightRect', { x: 0, y: 470, width: 90, height: 10 }], ['Overlay.hideHighlight', undefined]]);
  } finally { await close(); }
});

test('a stored selector is highlighted again through the protocol, never a page script, and only while annotating', { timeout: 2000 }, async () => {
  const { engine, command, cdpCalls, methods, close } = fixture();
  const base = engine.cdp;
  const dom = { nodeId: 42 as number, border: [20.4, 30, 140, 30, 140, 60, 20.4, 60] as number[] | null };
  engine.cdp = async (tab: unknown, method: string, params?: Record<string, unknown>) => {
    const result = await base(tab, method, params);
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') return { nodeId: dom.nodeId };
    if (method === 'DOM.getBoxModel') return dom.border ? { model: { border: dom.border } } : {};
    return result;
  };
  try {
    await assert.rejects(command('annotateHighlight', { ...human, selector: 'button#checkout' }), refused(409), 'not annotating');
    await command('annotateStart', human);
    for (const selector of ['', 'a'.repeat(501), 'button\n#x', 42]) {
      await assert.rejects(command('annotateHighlight', { ...human, selector }), refused(400), String(selector).slice(0, 20));
    }
    cdpCalls.length = 0;
    const shown = await command('annotateHighlight', { ...human, selector: 'button#checkout' });
    assert.deepEqual(shown, { highlight: { found: true, visible: true, rect: { x: 20.4, y: 30, width: 119.6, height: 30 } } });
    assert.deepEqual(cdpCalls.find(([method]) => method === 'DOM.querySelector')?.[1], { nodeId: 1, selector: 'button#checkout' });
    assert.ok(methods().includes('Overlay.highlightRect'));
    assert.ok(!methods().some((method) => /^Runtime\./.test(method)), 'no script of the page runs');

    dom.nodeId = 0;
    cdpCalls.length = 0;
    assert.deepEqual(await command('annotateHighlight', { ...human, selector: '.gone' }), { highlight: { found: false } });
    assert.deepEqual(methods().slice(-1), ['Overlay.hideHighlight']);
    dom.nodeId = 42;
    dom.border = null;
    assert.deepEqual(await command('annotateHighlight', { ...human, selector: 'button' }), { highlight: { found: true, visible: false } });
    await assert.rejects(command('annotateHighlight', { selector: 'button', commandActor: 'agent' }), refused(403), 'an agent never highlights');
  } finally { await close(); }
});

test('Escape leaves annotate mode, turns the preload and the highlight domains off, and keeps the picks', { timeout: 2000 }, async () => {
  const { command, ipc, tabs, methods, cdpCalls, settle, close } = fixture();
  try {
    await command('annotateStart', human);
    ipc(EVENT, tabs.a.view.webContents, pick());
    await settle();
    cdpCalls.length = 0;
    ipc(EVENT, tabs.a.view.webContents, { type: 'exit', reason: 'escape' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(tabs.a.view.webContents.sent.at(-1), [TOGGLE, false]);
    assert.deepEqual(methods(), ['Overlay.hideHighlight', 'Overlay.disable', 'DOM.disable']);
    assert.deepEqual((await command('status')).annotation, { active: false, pending: 1, queued: 0, capturing: 0, stoppedReason: 'escape' });
    assert.equal(ipc(STATE, tabs.a.view.webContents).returnValue, false);
    await command('navigate', { url: 'https://x.test/' });
    const stopped = await command('annotateStop', human);
    assert.equal(stopped.annotation.picks.length, 1, 'stopping hands back what was not collected');
    assert.deepEqual((await command('annotateStop', human)).annotation.picks, [], 'stopping twice is harmless');
  } finally { await close(); }
});

test('switching or closing the annotated tab ends annotate mode', { timeout: 2000 }, async () => {
  const { command, close } = fixture();
  try {
    await command('annotateStart', human);
    await command('activateTab', { tabId: 'tab-b', ...human });
    assert.deepEqual((await command('status')).annotation, { active: false, pending: 0, queued: 0, capturing: 0, stoppedReason: 'tab-change' });
    await command('annotateStart', human);
    assert.equal((await command('status')).annotation.tabId, 'tab-b');
    await command('closeTab', { tabId: 'tab-b', ...human });
    assert.equal((await command('status')).annotation.stoppedReason, 'tab-closed');
  } finally { await close(); }
});

test('a minute without a pick or a hover ends annotate mode', { timeout: 2000 }, async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_753_500_000_000 });
  const { command, ipc, tabs, close } = fixture();
  try {
    await command('annotateStart', human);
    mock.timers.tick(annotator.ANNOTATION_IDLE_MS - 1);
    ipc(EVENT, tabs.a.view.webContents, { type: 'hover', tag: 'div', rect: { x: 1, y: 1, width: 5, height: 5 } });
    mock.timers.tick(1);
    assert.equal((await command('status')).annotation.active, true, 'a hover pushes the deadline');
    mock.timers.tick(annotator.ANNOTATION_IDLE_MS - 1);
    assert.equal((await command('status')).annotation.stoppedReason, 'idle');
    assert.deepEqual(tabs.a.view.webContents.sent.at(-1), [TOGGLE, false]);
  } finally { await close(); mock.timers.reset(); }
});

test('the PWA point is relayed to the annotated tab preload and answered with a capture', { timeout: 2000 }, async () => {
  const { command, ipc, tabs, close } = fixture();
  const contents = tabs.a.view.webContents;
  const requests: Array<Record<string, unknown>> = [];
  contents.onSend = (channel, value) => {
    if (channel !== PICK_AT) return;
    const request = value as Record<string, unknown>;
    requests.push(request);
    // The preload answers on the event channel with the request id it was given.
    queueMicrotask(() => {
      if (request.x === 600) ipc(EVENT, contents, { type: 'miss', requestId: request.requestId });
      else if (request.preview) ipc(EVENT, contents, { type: 'hover', requestId: request.requestId, tag: 'button', rect: { x: 1, y: 2, width: 3, height: 4 } });
      else ipc(EVENT, contents, { ...pick(), point: { x: request.x, y: request.y }, requestId: request.requestId });
    });
  };
  try {
    await assert.rejects(command('annotatePick', { x: 50, y: 40, ...human }), refused(409), 'not annotating');
    await command('annotateStart', human);
    for (const [x, y] of [[-1, 4], [640, 4], [4, 480], [Number.NaN, 4], ['4', 4]]) {
      await assert.rejects(command('annotatePick', { x, y, ...human }), refused(400), `${x},${y}`);
    }
    await assert.rejects(command('annotatePick', { x: 4, y: 4, preview: 'yes', ...human }), refused(400));
    const { annotation } = await command('annotatePick', { x: 50, y: 40, ...human });
    assert.equal(annotation.target.selector, 'button#checkout');
    assert.deepEqual(annotation.point, { x: 50, y: 40 });
    assert.equal(annotation.source.detected, true);
    assert.deepEqual((await command('annotatePick', { x: 5, y: 6, preview: true, ...human })).hover,
      { rect: { x: 1, y: 2, width: 3, height: 4 }, tag: 'button' });
    await assert.rejects(command('annotatePick', { x: 600, y: 6, ...human }), refused(404));
    assert.deepEqual(requests.map((request) => [request.x, request.y, request.preview]), [[50, 40, false], [5, 6, true], [600, 6, false]]);
    assert.ok(requests.every((request) => typeof request.requestId === 'string' && request.requestId.length >= 32));
    assert.equal((await command('status')).annotation.pending, 0, 'a PWA pick is answered, not queued');
    // A forged answer with an unknown request id is not a pick.
    ipc(EVENT, contents, { ...pick(), requestId: 'forged' });
    assert.equal((await command('status')).annotation.pending, 0);
  } finally { await close(); }
});

test('the PWA\'s pins follow their elements: the preload reports where they are, the answer holds rectangles only', { timeout: 2000 }, async () => {
  const { command, ipc, tabs, profile, close } = fixture();
  const contents = tabs.a.view.webContents;
  const TRACK = bubbleRules.BROWSER_ANNOTATE_TRACK_CHANNEL;
  let anchors = 0;
  contents.onSend = (channel, value) => {
    if (channel !== PICK_AT) return;
    const request = value as Record<string, unknown>;
    // The preload remembers the element it picked for the PWA, as for a click in the view.
    queueMicrotask(() => ipc(EVENT, contents, { ...pick(), point: { x: request.x, y: request.y }, requestId: request.requestId, anchor: `a${++anchors}` }));
  };
  // Sent from the vm realm: compared as plain data.
  const tracked = () => contents.sent.filter(([channel]) => channel === TRACK).map(([, list]) => JSON.parse(JSON.stringify(list)) as unknown);
  try {
    const stranger = 'ba-00000000-0000-4000-8000-0000000000ff';
    // Outside annotate mode nothing is followed.
    assert.deepEqual(await command('annotatePins', { ...human, ids: [stranger] }), { pins: [{ id: stranger, rect: null }] });
    assert.deepEqual(tracked(), []);
    await command('annotateStart', human);
    for (const ids of [['../x'], 'ba-x', Array.from({ length: 22 }, () => stranger)]) {
      await assert.rejects(command('annotatePins', { ...human, ids }), refused(400));
    }
    const first = `ba-${(await command('annotatePick', { x: 50, y: 40, ...human })).annotation.id}`;
    const second = `ba-${(await command('annotatePick', { x: 60, y: 90, ...human })).annotation.id}`;
    const picked = { x: 20, y: 30, width: 120, height: 30 };
    const answer = await command('annotatePins', { ...human, ids: [first, stranger] });
    assert.deepEqual(answer, { pins: [{ id: first, rect: picked }, { id: stranger, rect: null }] });
    assert.ok(!JSON.stringify(answer).includes('Checkout'), 'never the page\'s words');
    assert.deepEqual(tracked().at(-1), ['a1'], 'the preload follows what the PWA shows');
    // The page scrolls: the preload reports, the next read has it; an element gone is null.
    ipc(EVENT, contents, { type: 'rects', rects: [{ anchor: 'a1', rect: { x: 20, y: -170, width: 120, height: 30 } }, { anchor: 'a2', rect: null }] });
    assert.deepEqual((await command('annotatePins', { ...human, ids: [first, second] })).pins,
      [{ id: first, rect: { x: 20, y: -170, width: 120, height: 30 } }, { id: second, rect: null }]);
    assert.deepEqual(tracked().at(-1), ['a1', 'a2']);
    // Another tab's report names other elements: it moves nothing.
    ipc(EVENT, tabs.b.view.webContents, { type: 'rects', rects: [{ anchor: 'a1', rect: { x: 0, y: 0, width: 1, height: 1 } }] });
    assert.deepEqual((await command('annotatePins', { ...human, ids: [first] })).pins[0].rect, { x: 20, y: -170, width: 120, height: 30 });
    // An empty list stops following.
    await command('annotatePins', { ...human, ids: [] });
    assert.deepEqual(tracked().at(-1), []);
    // The pins go with annotate mode.
    await command('annotateStop', human);
    assert.equal(profile.pwaPins.size, 0);
    assert.deepEqual((await command('annotatePins', { ...human, ids: [first] })).pins, [{ id: first, rect: null }]);
  } finally { await close(); }
});

test('a page that never answers the PWA point times out', { timeout: 6000 }, async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { command, close } = fixture();
  try {
    await command('annotateStart', human);
    const pending = command('annotatePick', { x: 5, y: 5, ...human });
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(3_000);
    await assert.rejects(pending, refused(504));
  } finally { await close(); mock.timers.reset(); }
});

test('picks waiting to be collected are bounded', { timeout: 4000 }, async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_753_500_000_000 });
  const { command, ipc, tabs, settle, close } = fixture();
  const warn = mock.method(console, 'warn', () => {});
  try {
    await command('annotateStart', human);
    for (let index = 0; index < annotator.ANNOTATION_MAX_PICKS + 3; index++) {
      mock.timers.tick(1_000);
      ipc(EVENT, tabs.a.view.webContents, pick());
      await settle();
    }
    assert.equal((await command('status')).annotation.pending, annotator.ANNOTATION_MAX_PICKS);
    assert.equal(warn.mock.callCount(), 3);
  } finally { warn.mock.restore(); await close(); mock.timers.reset(); }
});

test('stopping the profile ends annotate mode and drops what was not collected', async () => {
  const body = source.slice(source.indexOf('private async stopProfile('), source.indexOf('async close()'));
  assert.match(body, /this\.stopAnnotation\(profile, 'profile-stopped'\)/);
  assert.match(body, /profile\.annotationPicks = \[\]/);
});

// ---- The comment bubble (TODO #481) --------------------------------------------------------------

const BUBBLE = bubbleRules.BUBBLE_CHANNEL;

test('in a presented view a pick opens the bubble, which only its own frame drives, and the page hears nothing typed', { timeout: 3000 }, async () => {
  const routes: Array<[string, string, unknown]> = [];
  const { command, ipc, tabs, profile, settle, close, present } = fixture({
    annotationRoutes: async (method: string, path: string, body: unknown) => { routes.push([method, path, JSON.parse(JSON.stringify(body ?? null))]); return { status: 200, body: {} }; },
  });
  try {
    present();
    await command('annotateStart', human);
    const page = tabs.a.view.webContents;
    ipc(EVENT, page, { ...pick(), anchor: 'a1' });
    await settle();
    const overlay = FakeOverlay.last!;
    const shown = overlay.calls.find(([kind]) => kind === 'show');
    assert.ok(shown, 'the bubble opens on the element');
    assert.deepEqual({ mode: (shown[1] as Record<string, unknown>).mode, number: (shown[1] as Record<string, unknown>).number,
      label: (shown[1] as Record<string, unknown>).label, canSend: (shown[1] as Record<string, unknown>).canSend },
    { mode: 'new', number: 1, label: '<button> Checkout', canSend: true });
    assert.deepEqual(shown[2], { x: 120, y: 40 + 30 + 30 + bubbleRules.BUBBLE_GAP, width: bubbleRules.BUBBLE_WIDTH, height: bubbleRules.BUBBLE_DEFAULT_HEIGHT },
      'below the element, in window coordinates');
    assert.equal((await command('status')).annotation.pending, 0, 'the app does not collect a pick the bubble holds');
    assert.ok(page.sent.some(([channel, value]) => channel === bubbleRules.BROWSER_ANNOTATE_TRACK_CHANNEL && JSON.stringify(value) === '["a1"]'));

    const SECRET_WORDS = 'make-the-checkout-button-green';
    // Anything but the bubble's own main frame is not heard: the page, a sub-frame of the bubble, a stranger.
    ipc(BUBBLE, page, { type: 'add', text: 'forged by the page' });
    ipc(BUBBLE, overlay.contents as unknown as FakeContents, { type: 'add', text: 'forged by a frame' }, {});
    ipc(BUBBLE, contentsAt('https://evil.test/'), { type: 'add', text: 'forged by a stranger' });
    ipc(BUBBLE, overlay.contents as unknown as FakeContents, { type: 'add', text: 'x'.repeat(30_000) });
    await settle();
    assert.deepEqual(profile.annotationPicks, []);
    ipc(BUBBLE, overlay.contents as unknown as FakeContents, { type: 'ready' });
    ipc(BUBBLE, overlay.contents as unknown as FakeContents, { type: 'draft', text: SECRET_WORDS });
    ipc(BUBBLE, overlay.contents as unknown as FakeContents, { type: 'add', text: SECRET_WORDS });
    await settle(); await settle();
    assert.equal(profile.annotationPicks.length, 1);
    const queued = profile.annotationPicks[0] as Record<string, unknown>;
    assert.deepEqual([queued.comment, queued.queued], [SECRET_WORDS, true]);
    assert.deepEqual(routes.map(([method, path]) => `${method} ${path}`), ['POST profile-a/annotation/collect'], 'sealed by the daemon at once');
    const status = (await command('status')).annotation;
    assert.deepEqual([status.pending, status.queued, status.queuedIds], [0, 1, [`ba-${queued.id}`]], 'the queue\'s ids: the app\'s Send posts this queue');
    assert.deepEqual(overlay.calls.filter(([kind]) => kind === 'pins').at(-1)?.[1], [{ key: queued.id, number: 1 }]);
    // The daemon's collect hands it over with the comment, under the capture's id.
    const { annotation } = await command('annotateCollect', human);
    assert.deepEqual(annotation.picks.map((capture: Record<string, unknown>) => [capture.id, capture.comment]), [[queued.id, SECRET_WORDS]]);
    assert.ok(!JSON.stringify(page.sent).includes(SECRET_WORDS), 'nothing typed in the bubble was sent to the page');
    assert.ok(!JSON.stringify(page.sent).includes('forged'));

    // Send: the queue is posted as one turn of the conversation, then annotate mode ends.
    ipc(EVENT, page, { ...pick({ point: { x: 300, y: 200 } }), anchor: 'a2' });
    await settle();
    ipc(BUBBLE, overlay.contents as unknown as FakeContents, { type: 'send', text: 'And this one' });
    await settle(); await settle(); await settle();
    const post = routes.find(([, path]) => path === 'profile-a/annotations/post');
    assert.equal((post?.[2] as { agent: string }).agent, 'rooks.coder');
    assert.equal((post?.[2] as { ids: string[] }).ids.length, 2);
    assert.equal((post?.[2] as { ids: string[] }).ids[0], `ba-${queued.id}`);
    assert.equal(profile.annotation.active, false);
    assert.ok(overlay.calls.some(([kind]) => kind === 'close'), 'the views go with annotate mode');
  } finally { await close(); }
});

test('without a presented view the pick waits for the app as before', { timeout: 2000 }, async () => {
  const { command, ipc, tabs, settle, close } = fixture();
  try {
    FakeOverlay.last = null;
    await command('annotateStart', human);
    ipc(EVENT, tabs.a.view.webContents, { ...pick(), anchor: 'a1' });
    await settle();
    assert.equal(FakeOverlay.last, null, 'no bubble is created');
    assert.equal((await command('status')).annotation.pending, 1);
  } finally { await close(); }
});

test('Escape on the page ends annotate mode and keeps what the bubble held; unpin drops a pin the app sent', { timeout: 3000 }, async () => {
  const { command, ipc, tabs, profile, settle, close, present } = fixture({ annotationRoutes: async () => ({ status: 503, body: {} }) });
  try {
    present();
    await command('annotateStart', human);
    const page = tabs.a.view.webContents;
    ipc(EVENT, page, { ...pick(), anchor: 'a1' });
    await settle();
    const overlay = FakeOverlay.last!;
    ipc(BUBBLE, overlay.contents as unknown as FakeContents, { type: 'draft', text: 'Typed before Escape' });
    ipc(EVENT, page, { type: 'exit', reason: 'escape' });
    await settle(); await settle();
    assert.equal(profile.annotation.active, false);
    assert.ok(overlay.calls.some(([kind]) => kind === 'close'));
    const queued = profile.annotationPicks.filter((capture: Record<string, unknown>) => capture.queued === true);
    assert.equal(queued.length, 1, 'the daemon could not be reached: it waits on the desktop');
    assert.equal((queued[0] as Record<string, unknown>).comment, 'Typed before Escape');
    await assert.rejects(command('annotateUnpin', { ...human, ids: ['../x'] }), refused(400));
    const result = await command('annotateUnpin', { ...human, ids: [`ba-${(queued[0] as Record<string, unknown>).id}`] });
    assert.deepEqual([result.unpinned, result.annotation.queued], [1, 0]);
  } finally { await close(); }
});
