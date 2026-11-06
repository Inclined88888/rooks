import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as protocol from './native-browser-protocol.js';
import * as credentials from './native-browser-credentials.js';

const nodeRequire = createRequire(import.meta.url);
const source = (await readFile(new URL('./native-browser.ts', import.meta.url), 'utf8'))
  .replaceAll('import.meta.url', JSON.stringify(new URL('./native-browser.ts', import.meta.url).href));
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

interface FakeImage { resizedTo?: { width: number; height: number } }

function fakeImage(width: number, height: number, bytes = 'frame'): FakeImage & Record<string, unknown> {
  const image: FakeImage & Record<string, unknown> = {
    isEmpty: () => width === 0 || height === 0,
    getSize: () => ({ width, height }),
    resize: (size: { width: number; height: number }) => ({ ...fakeImage(size.width, size.height, `${bytes}@${size.width}x${size.height}`), resizedTo: size }),
    toJPEG: (quality: number) => Buffer.from(quality === 72 ? bytes : 'wrong-quality'),
  };
  return image;
}

function fixture() {
  const exports: Record<string, any> = {};
  const ipcMain = new EventEmitter();
  runInNewContext(compiled, {
    exports, console, Buffer, URL, setTimeout, clearTimeout,
    require: (name: string) => name === 'electron' ? { ipcMain }
      : name === './native-browser-protocol.js' ? protocol
        : name === './native-browser-credentials.js' ? credentials : nodeRequire(name),
  });
  const engine = new exports.NativeBrowserEngine('/unused');
  const contents: Record<string, unknown> = { getURL: () => 'https://example.com/', getTitle: () => 'Fixture',
    isDestroyed: () => false, navigationHistory: { canGoBack: () => false, canGoForward: () => false } };
  const tab = { id: 'tab', view: { webContents: contents } };
  const profile = { id: 'profile-a', dialogs: new Map(), tabs: new Map([['tab', tab]]), activeTabId: 'tab',
    viewport: { width: 640, height: 480, mobile: false }, fileChooser: null, permissions: new Map(),
    downloads: new Map(), contextMenu: null, audioMuted: true, annotation: null, annotationPicks: [], annotationCapturing: 0 };
  engine.profiles.set(profile.id, profile);
  const command = (action: string, body: Record<string, unknown> = {}) => engine.command({ profileId: profile.id, action, ...body });
  const close = async () => { engine.queues.clear(); engine.profiles.clear(); await engine.close(); };
  return { engine, profile, contents, command, close };
}

test('pending dialogs reject new renderer work immediately but allow status and the dialog response', { timeout: 1000 }, async () => {
  const { engine, profile, command, close } = fixture();
  let answered = false;
  profile.dialogs.set('dialog', { id: 'dialog', tabId: 'tab', type: 'prompt', respond: () => { answered = true; } });
  engine.queues.set(profile.id, new Promise(() => {}));
  try {
    for (const action of ['resize', 'screenshot', 'evaluate', 'input', 'clipboardRead', 'captureCredential']) {
      await assert.rejects(command(action), (error: unknown) => error instanceof protocol.BrowserCommandError && error.statusCode === 409);
    }
    assert.throws(() => engine.mediaSource(profile.id), /pending browser dialog/);
    assert.equal((await command('status')).dialog.id, 'dialog');
    await command('dialogRespond', { dialogId: 'dialog', accept: false });
    assert.equal(answered, true);
    assert.equal(profile.dialogs.size, 0);
  } finally { await close(); }
});

test('a dialog appearing while resize is queued prevents viewport mutation and CDP calls', { timeout: 1000 }, async () => {
  const { engine, profile, command, close } = fixture();
  let release!: () => void;
  engine.queues.set(profile.id, new Promise<void>((resolve) => { release = resolve; }));
  engine.cdp = () => assert.fail('A blocked renderer must not receive another CDP command');
  const pending = command('resize', { width: 390, height: 844, mobile: true });
  profile.dialogs.set('dialog', { id: 'dialog' });
  try {
    release();
    await assert.rejects(pending, /pending browser dialog/);
    assert.deepEqual(profile.viewport, { width: 640, height: 480, mobile: false });
  } finally { await close(); }
});

test('a dialog does not cancel an already started screenshot or invalidate an existing media source', { timeout: 1000 }, async () => {
  const { engine, profile, command, contents, close } = fixture();
  let complete!: (image: FakeImage) => void;
  let started!: () => void;
  const wasStarted = new Promise<void>((resolve) => { started = resolve; });
  contents.capturePage = () => { started(); return new Promise((resolve) => { complete = resolve; }); };
  const source = engine.mediaSource(profile.id);
  const screenshot = command('screenshot');
  try {
    await wasStarted;
    profile.dialogs.set('dialog', { id: 'dialog' });
    complete(fakeImage(640, 480, 'completed-frame'));
    assert.equal((await screenshot).data, Buffer.from('completed-frame').toString('base64'));
    assert.equal(source.webContents, contents);
  } finally { await close(); }
});

test('screenshot captures the composited frame without the debugger, in viewport CSS px', { timeout: 1000 }, async () => {
  const { engine, contents, command, close } = fixture();
  engine.cdp = () => assert.fail('Page.captureScreenshot never answers one call in two on a static page (TODO #473)');
  try {
    contents.capturePage = async () => fakeImage(640, 480);
    assert.deepEqual({ ...(await command('screenshot')) },
      { data: Buffer.from('frame').toString('base64'), mimeType: 'image/jpeg', width: 640, height: 480 });
    // A HiDPI frame comes back at the size the command always declared.
    contents.capturePage = async () => fakeImage(1280, 960);
    const hidpi = await command('screenshot');
    assert.equal(Buffer.from(hidpi.data, 'base64').toString(), 'frame@640x480');
    assert.deepEqual([hidpi.width, hidpi.height], [640, 480]);
  } finally { await close(); }
});

test('screenshot refuses an empty frame and a closed tab instead of answering a blank image', { timeout: 1000 }, async () => {
  const { contents, command, close } = fixture();
  try {
    contents.capturePage = async () => fakeImage(0, 0);
    await assert.rejects(command('screenshot'), (error: unknown) => error instanceof protocol.BrowserCommandError && error.statusCode === 503);
    contents.isDestroyed = () => true;
    contents.capturePage = () => assert.fail('A closed tab must not be captured');
    await assert.rejects(command('screenshot'), (error: unknown) => error instanceof protocol.BrowserCommandError && error.statusCode === 409);
  } finally { await close(); }
});
