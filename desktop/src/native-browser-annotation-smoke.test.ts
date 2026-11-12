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
 * Annotate mode end to end under the pinned Electron (TODO #468): the real preload and the real
 * engine, human input through `webContents.sendInputEvent` (the OS input path, no debugger).
 * Touch has no sendInputEvent form: it goes through `Input.dispatchTouchEvent`, trusted as well.
 */

const MODULES = ['native-browser', 'native-browser-protocol', 'native-browser-credentials', 'native-browser-user-agent',
  'native-browser-devtools', 'native-browser-cookies', 'native-browser-chrome', 'native-browser-chrome-signin',
  'native-browser-recorder', 'native-browser-annotator'];

/** The classic Runtime.enable tell: a console argument whose `stack` getter runs only when serialised. */
const RUNTIME_TELL = String.raw`
window.__runtimeTell = 0;
setInterval(() => {
  const probe = new Error('tell');
  Object.defineProperty(probe, 'stack', { configurable: true, get() { window.__runtimeTell++; return ''; } });
  console.debug(probe);
}, 40);
`;

const fixture = String.raw`
const { app, dialog } = require('electron');
const { createServer } = require('node:http');
const { join } = require('node:path');
const home = process.env.ROOKS_HOME;
const fail = (error) => { require('node:fs').writeSync(2, String(error?.stack ?? error) + '\n'); app.exit(1); };
dialog.showErrorBox = (title, content) => fail(title + '\n' + content);
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
app.setPath('userData', join(home, 'shell'));
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const TYPES = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu',
  'touchstart', 'touchmove', 'touchend', 'touchcancel', 'keydown', 'keyup'];
const head = (title) => '<!doctype html><meta charset="utf-8"><title>' + title + '</title><script>' + ${JSON.stringify(RUNTIME_TELL)}
  + 'window.seen = []; for (const type of ' + JSON.stringify(TYPES) + ') {'
  + ' window.addEventListener(type, () => seen.push(type), { capture: true, passive: false });'
  + ' document.addEventListener(type, () => seen.push("document:" + type), { capture: true, passive: false }); }</script>'
  + '<style>body{margin:0;background:#fff}#buy,#pw,#zone,#target{position:absolute;left:20px;width:200px;height:30px;margin:0}'
  + '#buy{top:20px}#pw{top:70px}#zone{top:200px;height:120px;width:300px}#target{top:20px}</style>';
// A React 18 fiber's shape, set from the page's own world: the passive walk must find it there.
const ANNOTATE = head('Annotate')
  + '<button id="buy" class="cta" onclick="window.bought = true">Buy now</button>'
  + '<input id="pw" name="pw" type="password" value="hunter2"><div id="zone"></div><script>'
  + 'const fiber = { type: "button", _debugSource: { fileName: "/home/dev/shop/src/Cart.jsx", lineNumber: 12, columnNumber: 7 },'
  + ' _debugOwner: { type: function Cart() {} } };'
  + 'document.getElementById("buy").__reactFiber$smoke = fiber;</script>';
// Booby-trapped like the spike's: every non-passive way of reading the expando runs page code.
const HOSTILE = head('Hostile') + '<button id="target">Hostile</button><script>'
  + 'window.__pageCalls = []; const bump = (what) => { window.__pageCalls.push(what); };'
  + 'Error.prepareStackTrace = () => { bump("prepareStackTrace"); return "prepared"; };'
  + 'const target = { _debugSource: { fileName: "/evil.jsx", lineNumber: 1 } };'
  + 'Object.defineProperty(target, "_debugOwner", { get() { bump("getter:_debugOwner"); return null; }, enumerable: true });'
  + 'const trap = (name, real) => function (...args) { bump("proxy:" + name); return real(...args); };'
  + 'const fiber = new Proxy(target, { get: trap("get", Reflect.get), getOwnPropertyDescriptor: trap("gopd", Reflect.getOwnPropertyDescriptor),'
  + ' ownKeys: trap("ownKeys", Reflect.ownKeys), has: trap("has", Reflect.has) });'
  + 'const element = document.getElementById("target"); element.__reactFiber$hostile = fiber;'
  + 'Object.defineProperty(element, "__reactProps$hostile", { get() { bump("getter:__reactProps"); return {}; }, enumerable: true });'
  + 'const realKeys = Object.keys; Object.keys = function (value) { bump("Object.keys"); return realKeys(value); };'
  + '</script>';
(async () => {
  await app.whenReady();
  app.dock?.hide();
  const { NativeBrowserEngine } = await import('./native-browser.js');
  const engine = new NativeBrowserEngine(home);
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url.startsWith('/hostile') ? HOSTILE : req.url.startsWith('/annotate') ? ANNOTATE : head('Other'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const command = (action, params = {}) => engine.command({ profileId: 'annotate', action, ...params });
  const human = { commandActor: 'human' };
  const outcome = (promise) => promise.then(() => 'accepted', error => error.statusCode ?? String(error));
  const profile = () => engine.profiles.get('annotate');
  const tabAt = (url) => [...profile().tabs.values()].find(tab => tab.view.webContents.getURL() === url);
  const waitFor = async (what, predicate) => {
    for (let i = 0; i < 200; i++) { const found = await predicate(); if (found) return found; await delay(25); }
    throw new Error('Timed out waiting for ' + what);
  };
  // A fresh document drops input until its first frame is presented; executeJavaScript attaches no debugger.
  const ready = async (url) => {
    const tab = await waitFor(url, () => tabAt(url));
    await waitFor('load ' + url, async () => !tab.view.webContents.isLoading());
    await tab.view.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    return tab.view.webContents;
  };
  const page = (contents, expression) => contents.executeJavaScript(expression);
  const click = async (contents, x, y, button = 'left') => {
    contents.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 });
    await delay(80);
  };
  const tap = async (contents, x, y) => {
    const send = (method, params) => contents.debugger.sendCommand(method, params);
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 2, y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await delay(250);
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  };
  const key = async (contents, keyCode) => {
    contents.sendInputEvent({ type: 'keyDown', keyCode });
    contents.sendInputEvent({ type: 'keyUp', keyCode });
    await delay(80);
  };
  const pixel = async (contents, x, y) => [...(await contents.capturePage({ x, y, width: 1, height: 1 })).toBitmap()].slice(0, 3);
  const status = async () => (await command('status')).annotation;
  const collect = async () => (await command('annotateCollect', human)).annotation.picks;
  const report = {};
  try {
    await command('start');
    const url = origin + '/annotate?session=launch-token';
    await command('navigate', { url });
    const contents = await ready(url);

    report.agentStart = await outcome(command('annotateStart'));
    report.agentStartClaimingHuman = await outcome(command('annotateStart', { commandActor: 'agent' }));
    await command('annotateStart', human);

    // Swallowing: left, right, middle, double click and a tap; nothing reaches the page.
    await click(contents, 60, 35);
    await waitFor('first pick', async () => (await status()).pending === 1);
    await delay(450);
    await click(contents, 60, 35, 'right');
    await click(contents, 60, 35, 'middle');
    contents.sendInputEvent({ type: 'mouseDown', x: 60, y: 35, button: 'left', clickCount: 2 });
    contents.sendInputEvent({ type: 'mouseUp', x: 60, y: 35, button: 'left', clickCount: 2 });
    await delay(450);
    await tap(contents, 60, 85);
    await waitFor('tap pick', async () => (await status()).pending === 2);
    report.swallowed = { seen: await page(contents, 'seen.splice(0)'), bought: await page(contents, '!!window.bought'),
      focus: await page(contents, 'document.activeElement.nodeName'), contextMenu: profile().contextMenu };

    // The agent is refused while the user annotates; it may still read the state.
    report.agentInput = await outcome(command('input', { event: { type: 'click', x: 60, y: 35 } }));
    report.agentNavigate = await outcome(command('navigate', { url: origin + '/other' }));
    report.agentStatus = await outcome(command('status'));

    // Hover paints the host's highlight over the element, not into the page.
    const before = await pixel(contents, 100, 250);
    contents.sendInputEvent({ type: 'mouseMove', x: 100, y: 250 });
    await delay(300);
    report.hover = { before, after: await pixel(contents, 100, 250), nodes: await page(contents, 'document.getElementsByTagName("*").length') };

    const picks = await collect();
    report.picks = picks;
    report.pending = (await status()).pending;

    // The PWA path: a point relayed to the preload, answered with a capture; a preview answers a rectangle.
    report.pwa = (await command('annotatePick', { x: 60, y: 35, ...human })).annotation;
    report.preview = (await command('annotatePick', { x: 60, y: 35, preview: true, ...human })).hover;
    report.pwaSeen = await page(contents, 'seen.splice(0)');

    // A hostile page: annotate mode survives the navigation, the walk triggers none of its traps.
    const hostileUrl = origin + '/hostile';
    await command('navigate', { url: hostileUrl, ...human });
    const hostile = await ready(hostileUrl);
    await click(hostile, 60, 35);
    await waitFor('hostile pick', async () => (await status()).pending === 1);
    report.hostile = { pick: (await collect())[0], pageCalls: await page(hostile, 'window.__pageCalls'),
      seen: await page(hostile, 'seen.splice(0)') };

    // Escape leaves; the page sees neither key event; afterwards clicks reach the page again.
    await key(hostile, 'Escape');
    report.escape = { status: await status(), seen: await page(hostile, 'seen.splice(0)') };
    await click(hostile, 60, 35);
    report.afterEscape = { seen: await page(hostile, 'seen.splice(0)'), pending: (await status()).pending };
    report.agentAfter = await outcome(command('navigate', { url: url }));
    const again = await ready(url);

    // Switching tab ends annotate mode.
    await command('annotateStart', human);
    await command('newTab', { url: origin + '/other', ...human });
    await ready(origin + '/other');
    report.tabChange = await status();
    report.tell = { annotate: await page(again, 'window.__runtimeTell') };
    console.log('ANNOTATION_REPORT ' + JSON.stringify(report));
  } finally {
    await engine.close();
    await new Promise(resolve => server.close(resolve));
  }
  app.exit(0);
})().catch(fail);
`;

/** Opt-in because this starts a real Electron process, even though all its windows stay hidden. */
test('annotation smoke: the real preload and engine swallow gestures, pick, mask, refuse the agent and read sources passively', {
  skip: process.env.ROOKS_ELECTRON_SMOKE !== '1', timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'rooks-annotation-smoke-'));
  const electron = createRequire(import.meta.url)('electron') as string;
  try {
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    for (const name of MODULES) {
      const source = await readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8');
      await writeFile(join(root, `${name}.js`), ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText);
    }
    await writeFile(join(root, 'native-browser-preload.cjs'), ts.transpileModule(
      await readFile(new URL('./native-browser-preload.cts', import.meta.url), 'utf8'),
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText);
    new Script(fixture, { filename: 'smoke.cjs' });
    await writeFile(join(root, 'smoke.cjs'), fixture);
    const env = { ...process.env, ROOKS_HOME: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(electron, [join(root, 'smoke.cjs')], {
      env, timeout: 50_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    }).catch((error) => { throw new Error(`Annotation smoke failed (${error.code ?? error.signal}): ${error.stdout}\n${error.stderr}`); });
    const line = stdout.split('\n').find((candidate) => candidate.startsWith('ANNOTATION_REPORT '));
    assert.ok(line, stdout);
    const report = JSON.parse(line.slice('ANNOTATION_REPORT '.length));
    const raw = JSON.stringify(report);

    assert.deepEqual([report.agentStart, report.agentStartClaimingHuman], [403, 403]);
    assert.deepEqual(report.swallowed, { seen: [], bought: false, focus: 'BODY', contextMenu: null }, JSON.stringify(report.swallowed));
    assert.deepEqual([report.agentInput, report.agentNavigate, report.agentStatus], [409, 409, 'accepted']);
    assert.notDeepEqual(report.hover.before, report.hover.after, 'the highlight is painted over the zone');

    const [buy, password] = report.picks;
    assert.equal(report.picks.length, 2);
    assert.equal(report.pending, 0, 'collecting drains');
    assert.equal(buy.target.selector, 'button#buy');
    assert.equal(buy.target.text, 'Buy now');
    assert.deepEqual(buy.target.classes, ['cta']);
    assert.match(buy.url, /\/annotate\?session=\{SECRET:session\}$/);
    assert.equal(buy.title, 'Annotate');
    assert.deepEqual(buy.source, { detected: true, framework: 'react', file: '/home/dev/shop/src/Cart.jsx', line: 12, column: 7,
      component: 'Cart', via: 'debugSource' });
    assert.equal(buy.thumbnail.mimeType, 'image/jpeg');
    assert.ok(buy.thumbnail.width > 0 && buy.thumbnail.width <= 800 && buy.thumbnail.data.length > 100, JSON.stringify(buy.thumbnail).slice(0, 200));
    assert.ok(!buy.outerHtml.includes('onclick'), buy.outerHtml);
    assert.deepEqual([password.target.tag, password.target.text, password.outerHtml], ['input', '', ''], 'the tap picked the password field');
    for (const secret of ['hunter2', 'launch-token']) assert.ok(!raw.includes(secret), `${secret} leaked`);

    assert.equal(report.pwa.target.selector, 'button#buy');
    assert.equal(report.pwa.source.detected, true);
    assert.equal(report.preview.tag, 'button');
    assert.deepEqual(report.pwaSeen, [], 'a PWA pick dispatches nothing to the page');

    assert.deepEqual(report.hostile.pick.source, { detected: false });
    assert.deepEqual(report.hostile.pageCalls, [], 'no trap, getter or patched builtin of the page ran');
    assert.deepEqual(report.hostile.seen, []);
    assert.equal(report.escape.status.stoppedReason, 'escape');
    assert.deepEqual(report.escape.seen, [], 'the page sees neither Escape keydown nor keyup');
    assert.ok(report.afterEscape.seen.includes('click'), JSON.stringify(report.afterEscape));
    assert.equal(report.afterEscape.pending, 0);
    assert.equal(report.agentAfter, 'accepted', 'the agent drives again once annotate mode ended');
    assert.equal(report.tabChange.stoppedReason, 'tab-change');
    assert.equal(report.tell.annotate, 0, 'Runtime was never enabled');
  } finally { await rm(root, { recursive: true, force: true }); }
});
