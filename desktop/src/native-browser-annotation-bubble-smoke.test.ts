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
 * The annotation bubble of TODO #481, end to end in a real Electron: the real engine, tab preload,
 * bubble view, bubble preload and pins, driven like a person would. Only the daemon is replaced, by
 * the routes the bubble calls (collect, comment, delete, post), answered here.
 *
 * Click an element → the bubble opens on it with the keyboard → type, Shift+Enter, Enter → a pin
 * numbered 1 → the page scrolls, the pin follows → a click on the pin reopens it → Escape → a second
 * element → type → "Send (2)" → one post with both annotations, in order, to the conversation the
 * panel is open for; annotate mode ends and the bubble's renderer with it. The page, watched from
 * its first script, sees no key, no focus change, no click of any of it.
 */

const MODULES = ['native-browser', 'native-browser-protocol', 'native-browser-credentials', 'native-browser-user-agent',
  'native-browser-devtools', 'native-browser-cookies', 'native-browser-chrome', 'native-browser-chrome-signin',
  'native-browser-recorder', 'native-browser-annotator', 'native-browser-bubble', 'native-browser-annotation-overlay'];

const fixture = String.raw`
const { app, dialog, BrowserWindow, desktopCapturer, screen } = require('electron');
const { createServer } = require('node:http');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const home = process.env.ROOKS_HOME;
const report = { checks: {} };
const fail = (error) => { require('node:fs').writeSync(2, String(error?.stack ?? error) + '\nPARTIAL ' + JSON.stringify(report) + '\n'); app.exit(1); };
dialog.showErrorBox = (title, content) => fail(title + '\n' + content);
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
app.setPath('userData', join(home, 'shell'));
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const VIEW = { width: 900, height: 480 };
const PANEL = { x: 240, y: 60 };
const WATCHED = ['keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'compositionstart', 'focus', 'blur', 'focusin', 'focusout',
  'pointerdown', 'mousedown', 'mouseup', 'click', 'contextmenu'];
const PAGE = '<!doctype html><meta charset="utf-8"><title>Shop</title><script>'
  + 'window.seen = []; const note = (what) => seen.push(what);'
  + 'for (const type of ' + JSON.stringify(WATCHED) + ') { window.addEventListener(type, (event) => note(type + (event.isTrusted ? "" : ":synthetic")), { capture: true }); }'
  + 'document.addEventListener("visibilitychange", () => note("visibilitychange:" + document.visibilityState));'
  + 'window.lostFocus = 0; setInterval(() => { if (!document.hasFocus()) lostFocus++; }, 20);'
  + '</script><style>body{margin:0;height:3000px;position:relative;font:16px sans-serif}'
  + 'button{position:absolute;width:160px;height:40px}#top{left:30px;top:30px}#mid{left:400px;top:200px}</style>'
  + '<button id="top">Pay</button><button id="mid">Checkout</button>';

(async () => {
  await app.whenReady();
  app.dock?.hide();
  const { NativeBrowserEngine } = await import('./native-browser.js');
  // The daemon, as far as the bubble sees it: the four routes it calls, answered from the engine's own queue.
  const sealed = new Map();
  const calls = [];
  let engine;
  const routes = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'POST' && path === 'work/annotation/collect') {
      const { annotation } = await engine.command({ profileId: 'work', action: 'annotateCollect', commandActor: 'human' });
      for (const capture of annotation.picks) sealed.set('ba-' + capture.id, { comment: capture.comment, status: 'draft', tag: capture.target.tag });
      return { status: 200, body: { annotations: annotation.picks.length } };
    }
    if (method === 'PATCH') { sealed.get(path.slice('annotations/'.length)).comment = body.comment; return { status: 200, body: {} }; }
    if (method === 'DELETE') { sealed.delete(path.slice('annotations/'.length)); return { status: 200, body: { deleted: true } }; }
    if (method === 'POST' && path === 'work/annotations/post') {
      for (const id of body.ids) sealed.get(id).status = 'sent';
      return { status: 200, body: { ok: true, missionId: 'm', spawned: false } };
    }
    return { status: 404, body: { error: 'unexpected ' + method + ' ' + path } };
  };
  engine = new NativeBrowserEngine(home, { annotationRoutes: routes });
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const command = (action, params = {}) => engine.command({ profileId: 'work', action, ...params });
  const human = { commandActor: 'human' };
  const profile = () => engine.profiles.get('work');
  const activeTab = () => profile().tabs.get(profile().activeTabId);
  const overlay = () => profile().overlay;
  const waitFor = async (what, predicate) => {
    for (let i = 0; i < 240; i++) { const found = await predicate(); if (found) return found; await delay(25); }
    throw new Error('Timed out waiting for ' + what);
  };
  const js = (contents, expression) => contents.executeJavaScript(expression);
  const click = async (contents, x, y) => {
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await delay(120);
  };
  const key = (contents, keyCode, modifiers = []) => {
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1 || keyCode === 'Enter') contents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : keyCode, modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  const type = async (contents, text) => { for (const letter of text) key(contents, letter); await delay(80); };
  const ui = new BrowserWindow({ show: false, x: 0, y: 0, width: VIEW.width + 400, height: VIEW.height + 120, useContentSize: true, title: 'Rooks',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await ui.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><title>Rooks</title><body style="margin:0;background:#223">'));
  // Shown and focused: a hidden window paints nothing and focuses no view.
  ui.show();
  ui.focus();
  await delay(300);
  const attach = async () => {
    const { viewToken } = await command('presentation');
    engine.attach(ui, { profileId: 'work', viewToken, bounds: { ...PANEL, ...VIEW },
      conversation: { agent: 'rooks.coder', mission: null }, locale: 'fr', scheme: 'light' });
  };
  const children = () => ui.contentView.children;
  const bubbleView = () => overlay()?.views().bubble ?? null;
  const pinViews = () => overlay()?.views().pins ?? [];
  const bubbleText = async () => {
    const contents = overlay().bubbleContents;
    return js(contents, '({ label: document.getElementById("label").textContent, number: document.getElementById("number").textContent,'
      + ' send: document.getElementById("send").textContent, add: document.getElementById("add").textContent,'
      + ' note: document.getElementById("note").value, focused: document.activeElement === document.getElementById("note"),'
      + ' error: document.getElementById("error").textContent })');
  };
  const focus = () => ({ ui: ui.webContents.isFocused(), page: activeTab().view.webContents.isFocused(),
    bubble: overlay()?.bubbleContents?.isFocused() ?? null });
  const noticed = async (page) => ({ seen: await js(page, 'seen.splice(0)'), lostFocus: await js(page, 'lostFocus'),
    hasFocus: await js(page, 'document.hasFocus()'), visibility: await js(page, 'document.visibilityState') });
  const shot = async (name) => {
    if (!process.env.ROOKS_BUBBLE_SHOTS) return;
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: VIEW.width + 400, height: VIEW.height + 120 } });
    const mine = sources.find((source) => source.name === 'Rooks');
    if (mine) writeFileSync(join(process.env.ROOKS_BUBBLE_SHOTS, name + '.png'), mine.thumbnail.toPNG());
  };
  const pinAt = () => { const views = pinViews(); return views.length ? views[0].getBounds() : null; };

  let page;
  try {
    await command('start');
    await command('resize', { width: VIEW.width, height: VIEW.height, mobile: false });
    await command('navigate', { url: origin + '/' });
    await waitFor('page', () => activeTab().view.webContents.getURL().startsWith(origin) && !activeTab().view.webContents.isLoading());
    await attach();
    page = activeTab().view.webContents;
    await command('annotateStart', human);
    await js(page, 'seen.splice(0); true');

    // ---- A click on an element opens the bubble on it, with the keyboard -------------------------
    const opened = performance.now();
    await click(page, 420, 210);
    await waitFor('the bubble', async () => bubbleView() && (await bubbleText()).label);
    const first = await bubbleText();
    report.checks.first = { ms: performance.now() - opened, text: first, focus: focus(), bounds: bubbleView().getBounds(),
      order: { page: children().indexOf(activeTab().view), bubble: children().indexOf(bubbleView()), count: children().length },
      status: (await command('status')).annotation };
    await shot('1-bubble-open');
    const bubble = overlay().bubbleContents;
    await type(bubble, 'Plus');
    key(bubble, 'Enter', ['shift']);
    await type(bubble, 'grand');
    report.checks.first.typing = await bubbleText();
    key(bubble, 'Enter');
    await waitFor('the first pin', () => pinViews().length === 1 && sealed.size === 1);
    await delay(150);
    const pinContents = pinViews()[0].webContents;
    report.checks.added = { sealed: JSON.parse(JSON.stringify([...sealed.values()])), bubbleShown: bubbleView() !== null, focus: focus(), pin: pinAt(),
      pinNumber: await js(pinContents, 'document.getElementById("pin").textContent'),
      samePid: pinContents.getOSProcessId() === bubble.getOSProcessId(),
      order: { page: children().indexOf(activeTab().view), pin: children().indexOf(pinViews()[0]) },
      status: (await command('status')).annotation, calls: calls.map(({ method, path }) => method + ' ' + path) };
    await shot('2-first-pin');

    // ---- The page scrolls: the pin follows its element ------------------------------------------
    await js(page, 'window.scrollBy(0, 100); true');
    await waitFor('the pin to follow', () => pinAt() && pinAt().y === report.checks.added.pin.y - 100);
    report.checks.scrolled = { pin: pinAt() };
    await js(page, 'window.scrollBy(0, -100); true');
    await waitFor('the pin to come back', () => pinAt() && pinAt().y === report.checks.added.pin.y);

    // ---- A click on the pin reopens its annotation; Escape closes the bubble only ---------------
    await click(pinContents, 12, 12);
    await waitFor('the bubble on the pin', async () => bubbleView() && (await bubbleText()).note === 'Plus\ngrand');
    report.checks.reopened = { text: await bubbleText(), focus: focus() };
    key(overlay().bubbleContents, 'Escape');
    await waitFor('the bubble to close', () => bubbleView() === null);
    await delay(100);
    report.checks.escaped = { focus: focus(), annotating: (await command('status')).annotation.active };

    // ---- A second element, typed into, then "Send (2)" with the mouse ---------------------------
    await click(page, 50, 40);
    await waitFor('the second bubble', async () => bubbleView() && (await bubbleText()).number === '2');
    await type(overlay().bubbleContents, 'Rouge');
    const second = await bubbleText();
    const button = await js(overlay().bubbleContents, '(() => { const r = document.getElementById("send").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()');
    await shot('3-second-bubble');
    const bubblePid = overlay().bubbleContents.getOSProcessId();
    const kept = { bubble: overlay().bubbleContents, pin: pinViews()[0].webContents };
    await click(overlay().bubbleContents, button.x, button.y);
    await waitFor('the post', () => calls.some(({ path }) => path === 'work/annotations/post'));
    await waitFor('annotate mode to end', async () => !(await command('status')).annotation.active);
    await delay(400);
    report.checks.sent = { second, post: calls.find(({ path }) => path === 'work/annotations/post').body, sealed: [...sealed.entries()],
      status: (await command('status')).annotation, children: children().length,
      closed: { bubble: kept.bubble.isDestroyed(), pin: kept.pin.isDestroyed() },
      rendererGone: !app.getAppMetrics().some((metric) => metric.pid === bubblePid), focus: { page: page.isFocused() } };
    report.checks.noticed = await noticed(page);
    report.electron = process.versions.electron;
    report.scale = screen.getPrimaryDisplay().scaleFactor;
    console.log('BUBBLE_REPORT ' + JSON.stringify(report));
  } finally {
    await engine.close();
    await new Promise(resolve => server.close(resolve));
  }
  app.exit(0);
})().catch(fail);
`;

interface Rect { x: number; y: number; width: number; height: number }
interface Text { label: string; number: string; send: string; add: string; note: string; focused: boolean; error: string }
interface Focus { ui: boolean; page: boolean; bubble: boolean | null }
interface Report {
  electron: string; scale: number;
  checks: {
    first: { ms: number; text: Text; typing: Text; focus: Focus; bounds: Rect; order: { page: number; bubble: number; count: number }; status: Record<string, unknown> };
    added: { sealed: Array<{ comment: string; status: string; tag: string }>; bubbleShown: boolean; focus: Focus; pin: Rect; pinNumber: string;
      samePid: boolean; order: { page: number; pin: number }; status: Record<string, unknown>; calls: string[] };
    scrolled: { pin: Rect };
    reopened: { text: Text; focus: Focus };
    escaped: { focus: Focus; annotating: boolean };
    sent: { second: Text; post: { ids: string[]; agent: string; missionId?: string }; sealed: Array<[string, { comment: string; status: string; tag: string }]>;
      status: Record<string, unknown>; children: number; closed: { bubble: boolean; pin: boolean }; rendererGone: boolean; focus: { page: boolean } };
    noticed: { seen: string[]; lostFocus: number; hasFocus: boolean; visibility: string };
  };
}

async function runSmoke(): Promise<Report> {
  const root = await mkdtemp(join(tmpdir(), 'rooks-bubble-smoke-'));
  const electron = createRequire(import.meta.url)('electron') as string;
  try {
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    for (const name of MODULES) {
      const source = await readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8');
      await writeFile(join(root, `${name}.js`), ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText);
    }
    for (const name of ['native-browser-preload', 'native-browser-bubble-preload']) {
      await writeFile(join(root, `${name}.cjs`), ts.transpileModule(await readFile(new URL(`./${name}.cts`, import.meta.url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText);
    }
    new Script(fixture, { filename: 'smoke.cjs' });
    await writeFile(join(root, 'smoke.cjs'), fixture);
    const env: NodeJS.ProcessEnv = { ...process.env, ROOKS_HOME: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(electron, [join(root, 'smoke.cjs')], {
      env, timeout: 90_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    }).catch((error) => { throw new Error(`Bubble smoke failed (${error.code ?? error.signal}): ${error.stdout}\n${error.stderr}`); });
    const line = stdout.split('\n').find((candidate) => candidate.startsWith('BUBBLE_REPORT '));
    assert.ok(line, stdout);
    return JSON.parse(line.slice('BUBBLE_REPORT '.length)) as Report;
  } finally { await rm(root, { recursive: true, force: true }); }
}

/**
 * Opt-in because this starts a real Electron process, and its window is SHOWN and focused for about
 * five seconds: a hidden window paints nothing and focuses no view, which is what is tested here. It
 * needs a desktop session. `ROOKS_BUBBLE_SHOTS=<dir>` saves what the window looked like at three steps.
 */
test('annotation bubble: click, type, Enter, pin, another, Send (2) — and the page sees none of it', {
  skip: process.env.ROOKS_ELECTRON_SMOKE !== '1', timeout: 120_000,
}, async () => {
  const { checks: { first, added, scrolled, reopened, escaped, sent, noticed }, electron } = await runSmoke();

  // The bubble opens on the element, above the page, with the keyboard, in the app's language.
  assert.deepEqual([first.text.label, first.text.number, first.text.add, first.text.send], ['<button> Checkout', '1', 'Ajouter', 'Envoyer (0)']);
  assert.equal(first.typing.send, 'Envoyer (1)', 'what is being typed counts');
  assert.equal(first.typing.note, 'Plus\ngrand', 'Shift+Enter breaks the line');
  assert.deepEqual(first.bounds, { x: 240 + 400, y: 60 + 200 + 40 + 8, width: first.bounds.width, height: first.bounds.height }, 'below the element');
  assert.ok(first.order.bubble > first.order.page, 'drawn above the page');
  assert.deepEqual([first.focus.bubble, first.focus.page, first.text.focused], [true, false, true], JSON.stringify(first.focus));
  assert.equal(first.status.pending, 0, 'the app\'s drawer is not handed the pick');
  assert.ok(first.ms < 3_000, `${first.ms} ms to show`);

  // Enter: queued, sealed at once with its comment, a pin numbered 1, the keyboard back on the page.
  assert.deepEqual(added.sealed, [{ comment: 'Plus\ngrand', status: 'draft', tag: 'button' }]);
  assert.deepEqual(added.calls, ['POST work/annotation/collect']);
  assert.deepEqual([added.bubbleShown, added.pinNumber, added.samePid], [false, '1', true], 'one renderer for the bubble and its pins');
  assert.ok(added.order.pin > added.order.page, 'the pin is above the page');
  assert.equal(added.focus.page, true);
  assert.equal(added.status.queued, 1);
  assert.equal(scrolled.pin.y, added.pin.y - 100, 'the pin follows its element');

  // The pin reopens its annotation; Escape closes the bubble only.
  assert.deepEqual([reopened.text.number, reopened.text.add, reopened.text.send], ['1', 'Enregistrer', 'Envoyer (1)']);
  assert.equal(reopened.focus.bubble, true);
  assert.deepEqual([escaped.focus.page, escaped.annotating], [true, true]);

  // Send (2): both, in the order pointed, to the panel's conversation; then annotate mode ends and the views go.
  assert.equal(sent.second.send, 'Envoyer (2)');
  assert.equal(sent.post.agent, 'rooks.coder');
  assert.equal(sent.post.missionId, undefined);
  assert.equal(sent.post.ids.length, 2);
  assert.deepEqual(sent.post.ids.map((id) => sent.sealed.find(([key]) => key === id)?.[1].comment), ['Plus\ngrand', 'Rouge']);
  assert.ok(sent.sealed.every(([, value]) => value.status === 'sent'));
  assert.equal(sent.status.active, false);
  assert.deepEqual(sent.closed, { bubble: true, pin: true });
  assert.equal(sent.rendererGone, true, 'the bubble\'s renderer ended');
  assert.equal(sent.children, 1, 'only the page is left in the window');

  // The page saw nothing: no key, no click, no focus change, never lost focus.
  assert.deepEqual(noticed, { seen: [], lostFocus: 0, hasFocus: true, visibility: 'visible' }, JSON.stringify(noticed));
  console.log(`bubble smoke: shown in ${Math.round(first.ms)} ms (Electron ${electron})`);
});
