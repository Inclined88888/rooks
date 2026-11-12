import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as protocol from './native-browser-protocol.js';

// Exercise the real engine's ownership and tickets without starting Chromium or a daemon.
const nodeRequire = createRequire(import.meta.url);
const source = readFileSync(new URL('./native-browser.ts', import.meta.url), 'utf8')
  .replaceAll('import.meta.url', JSON.stringify(new URL('./native-browser.ts', import.meta.url).href));
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function container() {
  const children = new Set<unknown>();
  return { children, addChildView: (view: unknown) => children.add(view), removeChildView: (view: unknown) => children.delete(view) };
}
function windowOf() {
  return { contentView: container(), getContentSize: () => [1000, 800], isDestroyed: () => false, isFocused: () => false };
}
type FakeWindow = ReturnType<typeof windowOf>;
function profileOf(id: string) {
  const view = { setVisible: (_value: boolean) => {}, setBounds: (_bounds: unknown) => {}, webContents: {
    isDestroyed: () => false, setAudioMuted: (_value: boolean) => {}, getURL: () => 'https://example.test/', getTitle: () => id,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  } };
  const host = { contentView: container() };
  host.contentView.addChildView(view);
  return { id, host, tabs: new Map([['tab', { id: 'tab', view }]]), activeTabId: 'tab', viewport: { width: 640, height: 480 },
    dialogs: new Map(), permissions: new Map(), downloads: new Map(), annotationPicks: [] };
}
type Profile = ReturnType<typeof profileOf>;
interface FakeTimer { callback: () => void; cleared: boolean; unref(): void }
interface Engine {
  profiles: Map<string, Profile>;
  tickets: protocol.BrowserPresentationTickets;
  attach(window: FakeWindow, request: unknown): void;
  detachWindow(window: FakeWindow): void;
  detach(): void;
  command(body: unknown): Promise<unknown>;
  bubbleHost(profile: Profile): { panel(): unknown; conversation(): unknown; routes(method: string, path: string): Promise<unknown> };
}
function fixture() {
  const timers: FakeTimer[] = [];
  const routed: FakeWindow[] = [];
  const exports: { NativeBrowserEngine?: new (home: string, options: unknown) => Engine } = {};
  runInNewContext(compiled, {
    exports, console, Buffer, URL,
    setTimeout: (callback: () => void) => { const timer = { callback, cleared: false, unref() {} }; timers.push(timer); return timer; },
    clearTimeout: (timer: FakeTimer) => { timer.cleared = true; },
    require: (name: string) => name === 'electron' ? { ipcMain: new EventEmitter() }
      : name === './native-browser-protocol.js' ? protocol : nodeRequire(name),
  });
  const engine = new exports.NativeBrowserEngine!('/unused', {
    annotationRoutesForWindow: (window: FakeWindow) => async () => { routed.push(window); return { status: 200 }; },
  });
  const first = windowOf(); const second = windowOf();
  const a = profileOf('a'); const b = profileOf('b');
  engine.profiles.set('a', a); engine.profiles.set('b', b);
  const request = (id: string) => ({ profileId: id, viewToken: engine.tickets.issue(id),
    bounds: { x: 10, y: 20, width: 640, height: 480 }, conversation: { agent: id, mission: null } });
  const tab = (profile: Profile) => profile.tabs.get('tab')!.view;
  return { engine, first, second, a, b, request, tab, timers, routed };
}

test('two windows present different profiles concurrently; renewal and detach affect only their window', async () => {
  const f = fixture();
  try {
    f.engine.attach(f.first, f.request('a'));
    f.engine.attach(f.second, f.request('b'));
    assert.ok(f.first.contentView.children.has(f.tab(f.a)));
    assert.ok(f.second.contentView.children.has(f.tab(f.b)));
    assert.equal(f.a.host.contentView.children.size, 0);
    f.engine.attach(f.first, f.request('a'));
    assert.ok(f.timers[0]!.cleared, 'renewing cancels only the old expiry');
    assert.equal(f.timers[1]!.cleared, false);
    assert.ok(f.second.contentView.children.has(f.tab(f.b)));
    await f.engine.bubbleHost(f.a).routes('POST', 'a/annotation/collect');
    await f.engine.bubbleHost(f.b).routes('POST', 'b/annotation/collect');
    assert.deepEqual(f.routed, [f.first, f.second], 'each bubble speaks through its own window');
    f.engine.detachWindow(f.first);
    assert.ok(f.a.host.contentView.children.has(f.tab(f.a)));
    assert.ok(f.second.contentView.children.has(f.tab(f.b)));
    await assert.rejects(f.engine.bubbleHost(f.a).routes('POST', 'a/annotation/collect'), /not presented/);
  } finally { f.engine.detach(); }
});

test('moving a profile parks the destination panel; an invalid ticket never moves either profile', () => {
  const f = fixture();
  try {
    f.engine.attach(f.first, f.request('a'));
    f.engine.attach(f.second, f.request('b'));
    assert.throws(() => f.engine.attach(f.second, { ...f.request('a'), profileId: 'b' }), /ticket/);
    assert.ok(f.first.contentView.children.has(f.tab(f.a)));
    assert.ok(f.second.contentView.children.has(f.tab(f.b)));
    f.engine.attach(f.second, f.request('a'));
    assert.equal(f.first.contentView.children.size, 0);
    assert.deepEqual([...f.second.contentView.children], [f.tab(f.a)]);
    assert.ok(f.b.host.contentView.children.has(f.tab(f.b)));
    f.engine.detachWindow(f.first);
    assert.ok(f.second.contentView.children.has(f.tab(f.a)), 'the old window cannot detach the new presentation');
  } finally { f.engine.detach(); }
});

test('expiry and control revocation stay profile-scoped; shutdown parks every view', async () => {
  const f = fixture();
  try {
    f.engine.attach(f.first, f.request('a'));
    f.engine.attach(f.second, f.request('b'));
    f.timers[0]!.callback();
    assert.ok(f.a.host.contentView.children.has(f.tab(f.a)));
    assert.ok(f.second.contentView.children.has(f.tab(f.b)));
    f.engine.attach(f.first, f.request('a'));
    await f.engine.command({ action: 'revokePresentation', profileId: 'a' });
    assert.ok(f.a.host.contentView.children.has(f.tab(f.a)));
    assert.ok(f.second.contentView.children.has(f.tab(f.b)));
    f.engine.attach(f.first, f.request('a'));
    f.engine.detach();
    assert.equal(f.first.contentView.children.size, 0);
    assert.equal(f.second.contentView.children.size, 0);
    assert.ok(f.a.host.contentView.children.has(f.tab(f.a)));
    assert.ok(f.b.host.contentView.children.has(f.tab(f.b)));
    assert.ok(f.timers.every((timer) => timer.cleared));
  } finally { f.engine.detach(); }
});
