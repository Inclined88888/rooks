import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Script } from 'node:vm';
import ts from 'typescript';

/**
 * Spike for TODO #461 (recording the built-in browser): can the recorder live in the tab preload
 * (isolated world, IPC to the main process) rather than in a CDP binding? Nothing here ships: the
 * real preload is compiled as is and a throwaway recorder is appended to it in the temp copy only.
 *
 * "Human" input is `webContents.sendInputEvent`: it enters the renderer through the same
 * RenderWidgetHost path as OS input and attaches no debugger, unlike the agent's `Input.*` gestures.
 */

const MODULES = ['native-browser', 'native-browser-protocol', 'native-browser-credentials', 'native-browser-user-agent',
  'native-browser-devtools', 'native-browser-cookies', 'native-browser-chrome', 'native-browser-chrome-signin', 'native-browser-recorder', 'native-browser-annotator'];

/** Appended to the compiled production preload: the shape task 1 would give the real recorder. */
const SPIKE_RECORDER = String.raw`
;(() => {
  const { ipcRenderer: recorderIpc } = require('electron');
  // One synchronous question per document: a popup's first document must know before its first click.
  let recording = recorderIpc.sendSync('timon:spike-record-state') === true;
  recorderIpc.on('timon:spike-record-toggle', (_event, on) => { recording = on === true; });
  const documentId = Math.random().toString(36).slice(2);
  const capture = (event) => {
    if (!recording) return;
    if (event.type === 'keydown' && event.key !== 'Enter') return;
    const target = event.target;
    // The real recorder drops untrusted events here; the spike forwards the flag to prove it is reliable.
    recorderIpc.send('timon:spike-record-event', { type: event.type, trusted: event.isTrusted, documentId,
      target: target && target.id ? target.id : String(target && target.nodeName), url: location.href });
  };
  for (const type of ['click', 'change', 'keydown']) window.addEventListener(type, capture, true);
  window.addEventListener('load', () => recorderIpc.send('timon:spike-record-hello', { documentId, url: location.href }));
})();
`;

/** The CDP fallback: same listener, in a named isolated world, reporting through Runtime.addBinding. */
const CDP_WORLD_SOURCE = String.raw`
// The DOM is shared between worlds: these marks tell the page-side probe whether the world script ran at all.
document.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.spikeWorld = typeof globalThis.__timonSpikeBinding;
});
document.addEventListener('click', () => { document.documentElement.dataset.spikeClicks = String(Number(document.documentElement.dataset.spikeClicks || 0) + 1); }, true);
for (const type of ['click', 'change', 'keydown']) window.addEventListener(type, (event) => {
  if (event.type === 'keydown' && event.key !== 'Enter') return;
  globalThis.__timonSpikeBinding(JSON.stringify({ type: event.type, trusted: event.isTrusted, target: event.target && event.target.id }));
}, true);
globalThis.__timonSpikeBinding(JSON.stringify({ type: 'hello', url: location.href }));
`;

const fixture = String.raw`
const { app, dialog, ipcMain } = require('electron');
const { createServer } = require('node:http');
const { join } = require('node:path');
const home = process.env.TIMON_HOME;
const fail = (error) => { require('node:fs').writeSync(2, String(error?.stack ?? error) + '\n'); app.exit(1); };
dialog.showErrorBox = (title, content) => fail(title + '\n' + content);
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
app.setPath('userData', join(home, 'shell'));
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const CDP_WORLD_SOURCE = ${JSON.stringify(CDP_WORLD_SOURCE)};
// Fixed positions so that the same coordinates drive human and agent gestures.
const page = (title) => '<!doctype html><title>' + title + '</title><style>body{margin:0}#btn,#popup,#field,#check{position:absolute;left:20px;width:200px;height:30px}#btn{top:20px}#popup{top:70px}#field{top:120px}#check{top:170px;width:30px}</style>'
  + '<button id="btn">Button</button><button id="popup" onclick="window.open(&quot;/popup&quot;)">Popup</button><input id="field"><input id="check" type="checkbox">'
  // A page that tries to swallow clicks before anyone else: it registers after the preload, so it comes second.
  + '<script>window.addEventListener("click", e => { if (window.swallow) e.stopImmediatePropagation(); }, true)</script>';
(async () => {
  await app.whenReady();
  app.dock?.hide();
  const report = { events: [], hellos: [], checks: {} };
  let recording = false;
  ipcMain.on('timon:spike-record-state', (event) => { event.returnValue = recording; });
  ipcMain.on('timon:spike-record-event', (event, payload) => {
    report.events.push({ ...payload, mainFrame: event.senderFrame === event.sender.mainFrame,
      contentsId: event.sender.id, debuggerAttached: event.sender.debugger.isAttached() });
  });
  ipcMain.on('timon:spike-record-hello', (event, payload) => {
    report.hellos.push({ ...payload, contents: event.sender, contentsId: event.sender.id,
      debuggerAttached: event.sender.debugger.isAttached() });
  });
  const { NativeBrowserEngine } = await import('./native-browser.js');
  const engine = new NativeBrowserEngine(home);
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(page(req.url === '/popup' ? 'Popup' : 'Page ' + req.url));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const command = (action, params = {}) => engine.command({ profileId: 'rec', action, ...params });
  const evaluate = async expression => (await command('evaluate', { expression })).result;
  const waitFor = async (what, predicate) => {
    for (let i = 0; i < 200; i++) { const found = predicate(); if (found) return found; await delay(25); }
    throw new Error('Timed out waiting for ' + what + ': ' + JSON.stringify({ events: report.events, hellos: report.hellos.map(h => h.url) }));
  };
  // A fresh document drops input until its first frame is presented; executeJavaScript attaches no debugger.
  const hello = async (url) => {
    const found = await waitFor('hello ' + url, () => [...report.hellos].reverse().find(h => h.url === url));
    await found.contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    return found;
  };
  const human = {
    click: async (contents, x, y) => {
      contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      await delay(80);
    },
    key: async (contents, keyCode) => {
      contents.sendInputEvent({ type: 'keyDown', keyCode });
      if (keyCode.length === 1) contents.sendInputEvent({ type: 'char', keyCode });
      contents.sendInputEvent({ type: 'keyUp', keyCode });
      await delay(80);
    },
  };
  const since = (mark, documentId) => report.events.slice(mark).filter(e => !documentId || e.documentId === documentId)
    .map(e => e.type + ':' + e.target + ':' + (e.trusted ? 'trusted' : 'synthetic'));
  try {
    await command('start');
    const firstUrl = origin + '/first';
    await command('navigate', { url: firstUrl });
    const first = await hello(firstUrl);
    const contents = first.contents;

    // 1a. Page already loaded, recording off: nothing leaves the preload.
    let mark = report.events.length;
    await human.click(contents, 60, 35);
    report.checks.offIsSilent = since(mark);

    // 1b. Same document, recording switched on from the main process.
    recording = true;
    contents.send('timon:spike-record-toggle', true);
    await delay(50);
    mark = report.events.length;
    await human.click(contents, 60, 35);
    await human.click(contents, 60, 135);
    for (const key of ['a', 'b', 'Enter']) await human.key(contents, key);
    await human.click(contents, 35, 185);
    await human.click(contents, 60, 35);
    await waitFor('loaded-page events', () => report.events.length - mark >= 6);
    report.checks.loadedPage = since(mark, first.documentId);
    report.checks.loadedPageFrames = report.events.slice(mark).every(e => e.mainFrame && e.contentsId === contents.id);

    // 1c. A page listener that stops propagation on window capture registers after the preload.
    await evaluate('window.swallow = true');
    mark = report.events.length;
    await human.click(contents, 60, 35);
    report.checks.pageCannotSwallow = since(mark);
    await evaluate('window.swallow = false');

    // 2. Synthetic events from the page arrive untrusted; the page sees no channel or binding.
    mark = report.events.length;
    await evaluate('document.getElementById("btn").click(); document.getElementById("btn").dispatchEvent(new MouseEvent("click", { bubbles: true })); document.getElementById("field").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); document.getElementById("check").dispatchEvent(new Event("change", { bubbles: true })); true');
    await waitFor('synthetic events', () => report.events.length - mark >= 4);
    report.checks.synthetic = since(mark);
    report.checks.pageGlobals = await evaluate('({ require: typeof require, process: typeof process, ipcRenderer: typeof ipcRenderer, electron: typeof electron, exposed: Object.getOwnPropertyNames(window).filter(name => /timon|ipc|spike|electron/i.test(name)) })');

    // 3. The agent's gestures (Input.dispatch*) are trusted too: the design excludes them by a 409.
    mark = report.events.length;
    await command('input', { event: { type: 'click', x: 60, y: 135 } });
    await command('input', { event: { type: 'key', key: 'Enter' } });
    await waitFor('agent events', () => report.events.length - mark >= 2);
    report.checks.agent = since(mark);

    // 1d. After a navigation, the new document asks for the state and records at once.
    const nextUrl = origin + '/next';
    await command('navigate', { url: nextUrl });
    const next = await hello(nextUrl);
    mark = report.events.length;
    await human.click(next.contents, 60, 35);
    await waitFor('navigation event', () => report.events.length > mark);
    report.checks.afterNavigation = { sameContents: next.contentsId === contents.id, newDocument: next.documentId !== first.documentId,
      events: since(mark, next.documentId) };

    // 1e. A new tab opened by the profile.
    const tabUrl = origin + '/tab';
    await command('newTab', { url: tabUrl });
    const tab = await hello(tabUrl);
    mark = report.events.length;
    await human.click(tab.contents, 60, 35);
    await waitFor('new tab event', () => report.events.length > mark);
    report.checks.newTab = { newContents: tab.contentsId !== contents.id, events: since(mark, tab.documentId) };

    // 1f. A site popup adopted as a tab (OAuth): its first document, before any debugger.
    mark = report.events.length;
    await human.click(tab.contents, 60, 85);
    const popup = await hello(origin + '/popup');
    report.checks.popupHelloDebuggerAttached = popup.debuggerAttached;
    for (let i = 0; i < 40 && (await command('status')).tabs.length !== 3; i++) await delay(50);
    report.checks.popupAdopted = (await command('status')).tabs.length === 3;
    const popupMark = report.events.length;
    await human.click(popup.contents, 60, 35);
    await waitFor('popup event', () => report.events.length > popupMark);
    report.checks.popup = { events: since(popupMark, popup.documentId),
      firstDocument: report.hellos.filter(h => h.contentsId === popup.contentsId).length === 1,
      opener: since(mark, tab.documentId) };

    // 4. CDP fallback in an isolated world, on a fresh tab whose Runtime domain was never enabled.
    const cdpUrl = origin + '/cdp';
    await command('newTab', { url: cdpUrl });
    const cdpTab = await hello(cdpUrl);
    const cdpContents = cdpTab.contents;
    const debug = cdpContents.debugger;
    if (!debug.isAttached()) debug.attach('1.3');
    const bindings = [];
    debug.on('message', (_event, method, params) => {
      if (method === 'Runtime.bindingCalled' && params.name === '__timonSpikeBinding') bindings.push({ ...JSON.parse(params.payload), contextId: params.executionContextId });
    });
    await debug.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: CDP_WORLD_SOURCE, worldName: 'timon-recorder' });
    await debug.sendCommand('Runtime.addBinding', { name: '__timonSpikeBinding', executionContextName: 'timon-recorder' });
    const reloaded = report.hellos.length;
    await debug.sendCommand('Page.reload');
    await waitFor('cdp tab reload', () => report.hellos.length > reloaded);
    await delay(150);
    const helloBindings = bindings.length;
    await human.click(cdpContents, 60, 35);
    await human.key(cdpContents, 'Enter');
    await delay(300);
    const withoutRuntime = { hello: helloBindings, events: bindings.slice(helloBindings).map(b => b.type + ':' + b.target + ':' + (b.trusted ? 'trusted' : 'synthetic')) };
    const mainWorldBinding = await cdpContents.executeJavaScript('typeof globalThis.__timonSpikeBinding');
    const worldMarks = await cdpContents.executeJavaScript('({ world: document.documentElement.dataset.spikeWorld ?? null, clicks: Number(document.documentElement.dataset.spikeClicks || 0) })');
    // Control: the same world with Runtime enabled, so that a negative answer above is not a broken fixture.
    let withRuntime = null;
    if (!withoutRuntime.hello) {
      await debug.sendCommand('Runtime.enable');
      const before = bindings.length;
      await debug.sendCommand('Page.reload');
      await delay(800);
      await human.click(cdpContents, 60, 35);
      await delay(300);
      withRuntime = bindings.slice(before).map(b => b.type);
    }
    report.checks.cdp = { withoutRuntime: { ...withoutRuntime, worldMarks }, withRuntime, mainWorldBinding };
    report.electron = process.versions.electron;
    report.chrome = process.versions.chrome;
    report.hellos = report.hellos.map(({ contents: _c, ...rest }) => rest);
    console.log('SPIKE_REPORT ' + JSON.stringify(report));
  } finally {
    await engine.close();
    await new Promise(resolve => server.close(resolve));
  }
  app.exit(0);
})().catch(fail);
`;

interface SpikeReport {
  electron: string;
  chrome: string;
  checks: {
    offIsSilent: string[];
    loadedPage: string[];
    loadedPageFrames: boolean;
    pageCannotSwallow: string[];
    synthetic: string[];
    pageGlobals: { require: string; process: string; ipcRenderer: string; electron: string; exposed: string[] };
    agent: string[];
    afterNavigation: { sameContents: boolean; newDocument: boolean; events: string[] };
    newTab: { newContents: boolean; events: string[] };
    popupHelloDebuggerAttached: boolean;
    popupAdopted: boolean;
    popup: { events: string[]; firstDocument: boolean; opener: string[] };
    cdp: {
      withoutRuntime: { hello: number; events: string[]; worldMarks: { world: string | null; clicks: number } };
      withRuntime: string[] | null;
      mainWorldBinding: string;
    };
  };
}

/** Opt-in because this starts a real Electron process, even though all its windows stay hidden. */
test('recording spike: a preload listener sees human, agent and synthetic events everywhere; CDP fallback probed', {
  skip: process.env.TIMON_ELECTRON_SMOKE !== '1', timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'timon-recording-spike-'));
  const electron = createRequire(import.meta.url)('electron') as string;
  try {
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    for (const name of MODULES) {
      const source = await readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8');
      await writeFile(join(root, `${name}.js`), ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText);
    }
    const preload = ts.transpileModule(await readFile(new URL('./native-browser-preload.cts', import.meta.url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    await writeFile(join(root, 'native-browser-preload.cjs'), preload + SPIKE_RECORDER);
    new Script(fixture, { filename: 'smoke.cjs' });
    await writeFile(join(root, 'smoke.cjs'), fixture);
    const env = { ...process.env, TIMON_HOME: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(electron, [join(root, 'smoke.cjs')], {
      env, timeout: 50_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
    }).catch((error) => { throw new Error(`Recording spike failed (${error.code ?? error.signal}): ${error.stdout}\n${error.stderr}`); });
    const line = stdout.split('\n').find((candidate) => candidate.startsWith('SPIKE_REPORT '));
    assert.ok(line, stdout);
    const report = JSON.parse(line.slice('SPIKE_REPORT '.length)) as SpikeReport;
    console.log(JSON.stringify({ electron: report.electron, chrome: report.chrome, checks: report.checks }, null, 2));
    const { checks } = report;

    assert.deepEqual(checks.offIsSilent, [], 'a disabled recorder sends nothing');
    assert.deepEqual(checks.loadedPage, [
      'click:btn:trusted', 'click:field:trusted', 'keydown:field:trusted', 'change:field:trusted',
      'click:check:trusted', 'change:check:trusted', 'click:btn:trusted',
    ], 'the preload of an already loaded page records clicks, Enter and changes as trusted');
    assert.ok(checks.loadedPageFrames, 'events come from the tab main frame');
    assert.deepEqual(checks.pageCannotSwallow, ['click:btn:trusted'], 'a page capture listener cannot hide a click from the preload');

    assert.deepEqual(checks.synthetic, ['click:btn:synthetic', 'click:btn:synthetic', 'keydown:field:synthetic', 'change:check:synthetic'],
      'events the page dispatches itself are untrusted, so they can be filtered');
    assert.deepEqual(checks.pageGlobals, { require: 'undefined', process: 'undefined', ipcRenderer: 'undefined', electron: 'undefined',
      exposed: ['__timonNativePrompt'] }, 'the page sees only the existing prompt bridge, no recorder channel');

    assert.deepEqual(checks.agent, ['click:field:trusted', 'keydown:field:trusted'],
      'agent CDP gestures are indistinguishable by isTrusted: recording must refuse them (409)');

    assert.deepEqual(checks.afterNavigation, { sameContents: true, newDocument: true, events: ['click:btn:trusted'] });
    assert.deepEqual(checks.newTab, { newContents: true, events: ['click:btn:trusted'] });

    assert.equal(checks.popupHelloDebuggerAttached, false, 'the popup first document runs the preload before any debugger');
    assert.ok(checks.popupAdopted, 'the popup became a tab of the profile');
    assert.deepEqual(checks.popup.events, ['click:btn:trusted']);
    assert.ok(checks.popup.firstDocument, 'the click landed in the popup first document');
    assert.deepEqual(checks.popup.opener, ['click:popup:trusted']);

    assert.equal(checks.cdp.mainWorldBinding, 'undefined', 'the isolated-world binding is not exposed to the page');
    // Electron 33 / Chromium 130: the world script runs, but Runtime.addBinding installs nothing in it until
    // Runtime.enable, the automation tell the browser avoids. If this flips on an upgrade, re-read PROGRESS (#461).
    assert.deepEqual(checks.cdp.withoutRuntime, { hello: 0, events: [], worldMarks: { world: 'undefined', clicks: 1 } },
      'without Runtime.enable the isolated world runs but never receives the binding');
    assert.deepEqual(checks.cdp.withRuntime, ['hello', 'click'], 'with Runtime.enable the same fallback reports');
  } finally { await rm(root, { recursive: true, force: true }); }
});
