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
 * Spike for TODO #481 (volet 1): a comment bubble of Rooks drawn over the page of the native browser.
 * Nothing here ships. The real engine and preload run as is; the bubble (its own WebContentsView,
 * preload, HTML and placement) and an anchor tracker appended to the preload copy exist only here.
 *
 * 1. the bubble's view sits above the page's view in the presenting window, at the element's rect,
 *    after a scroll, at the edge of the viewport, after a resize, at device scale 1 and 2;
 * 2. the keyboard focus moves into the bubble and the page notices nothing (keys, focus, blur,
 *    hasFocus, visibility, occlusion) and cannot reach it;
 * 3. Enter, Shift+Enter, Escape; clean close (view removed, contents closed, focus back); several bubbles;
 * 4. coexistence with annotate mode: a click in the bubble picks nothing;
 * 5. cost: time to show, renderer memory, reused versus recreated view.
 *
 * "Human" input is `webContents.sendInputEvent` (no debugger). It targets one webContents whatever
 * the focus, so "where do the OS keys go" is read from `webContents.isFocused()`, which is what
 * Chromium routes the window's key events by.
 */

const MODULES = ['native-browser', 'native-browser-protocol', 'native-browser-credentials', 'native-browser-user-agent',
  'native-browser-devtools', 'native-browser-cookies', 'native-browser-chrome', 'native-browser-chrome-signin',
  'native-browser-recorder', 'native-browser-annotator'];

/**
 * Appended to the compiled production preload: what the real one would add to keep a bubble on its
 * element. The main process names the element by the point it was picked at; the preload reports its
 * rectangle on every scroll (any scroller: capture on window) and resize, one message per frame.
 */
const SPIKE_ANCHOR = String.raw`
;(() => {
  const { ipcRenderer: anchorIpc } = require('electron');
  let anchored = null;
  let queued = false;
  const report = () => {
    queued = false;
    if (!anchored) return;
    const rect = anchored.getBoundingClientRect();
    anchorIpc.send('rooks:spike-anchor-rect', { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      viewport: { width: innerWidth, height: innerHeight } });
  };
  const schedule = () => { if (anchored && !queued) { queued = true; requestAnimationFrame(report); } };
  anchorIpc.on('rooks:spike-anchor', (_event, point) => {
    anchored = point ? document.elementFromPoint(point.x, point.y) : null;
    schedule();
  });
  window.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule, { passive: true });
})();
`;

/** The bubble's own preload: three verbs and one listener, nothing else of Electron. */
const BUBBLE_PRELOAD = String.raw`
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rooksBubble', {
  submit: (text) => ipcRenderer.send('rooks:spike-bubble', { type: 'submit', text: String(text) }),
  cancel: () => ipcRenderer.send('rooks:spike-bubble', { type: 'cancel' }),
  ready: (state) => ipcRenderer.send('rooks:spike-bubble', { type: 'ready', state }),
  onShow: (listener) => ipcRenderer.on('rooks:spike-bubble-show', (_event, data) => listener(data)),
});
`;

/** The bubble's document: a textarea and a button. Enter sends, Shift+Enter breaks the line, Escape cancels. */
const BUBBLE_HTML = '<!doctype html><meta charset="utf-8">'
  + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'">'
  + '<style>html,body{margin:0;background:transparent;overflow:hidden}'
  + '#card{box-sizing:border-box;margin:6px;height:calc(100vh - 12px);border-radius:12px;background:#fff;'
  + 'box-shadow:0 4px 16px rgba(0,0,0,.25);padding:8px;display:flex;flex-direction:column;gap:6px;font:13px sans-serif}'
  + '#note{flex:1;resize:none;border:0;outline:0;font:inherit}#send{align-self:flex-end}</style>'
  + '<div id="card"><div id="label"></div><textarea id="note" placeholder="Comment"></textarea><button id="send">Send</button></div>'
  + '<script>'
  + 'window.log = []; for (const type of ["focus", "blur"]) window.addEventListener(type, () => log.push("window:" + type));'
  + 'const note = document.getElementById("note");'
  // Whether an opaque origin (data:) accepts a BroadcastChannel: recorded either way (Electron 33 does not throw).
  + 'window.channel = []; try { new BroadcastChannel("rooks").onmessage = (event) => channel.push(String(event.data)); }'
  + ' catch (error) { channel.push("refused:" + error.name); }'
  + 'note.addEventListener("keydown", (event) => {'
  + ' if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); rooksBubble.submit(note.value); }'
  + ' else if (event.key === "Escape") { event.preventDefault(); rooksBubble.cancel(); } });'
  + 'document.getElementById("send").addEventListener("click", () => rooksBubble.submit(note.value));'
  + 'const show = (data) => { document.getElementById("label").textContent = data.label; note.value = ""; note.focus();'
  + ' setTimeout(() => rooksBubble.ready({ dpr: devicePixelRatio, visibility: document.visibilityState,'
  + '  inner: { width: innerWidth, height: innerHeight }, focused: document.activeElement === note, hasFocus: document.hasFocus() })); };'
  + 'rooksBubble.onShow(show);'
  + '</script>';

const fixture = String.raw`
const { app, dialog, BrowserWindow, WebContentsView, ipcMain, screen, session } = require('electron');
const { createServer } = require('node:http');
const { join } = require('node:path');
const home = process.env.ROOKS_HOME;
const SCALE = process.env.ROOKS_SPIKE_SCALE;
if (SCALE) app.commandLine.appendSwitch('force-device-scale-factor', SCALE);
const report = { scale: SCALE, checks: {} };
const fail = (error) => { require('node:fs').writeSync(2, String(error?.stack ?? error) + '\nPARTIAL ' + JSON.stringify(report) + '\n'); app.exit(1); };
dialog.showErrorBox = (title, content) => fail(title + '\n' + content);
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
app.setPath('userData', join(home, 'shell'));
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const BUBBLE_HTML = ${JSON.stringify(BUBBLE_HTML)};
const BUBBLE = { width: 280, height: 132, gap: 8 };
// Small enough to fit a 720 px high screen at device scale 2: a window is never larger than its display.
const VIEW = { width: 900, height: 480 };
const SMALL = { width: 800, height: 420 };

// Every way a page could notice the bubble, listened to from the earliest point a page can.
const WATCHED = ['keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'compositionstart', 'focus', 'blur', 'focusin', 'focusout',
  'pointerdown', 'mousedown', 'click', 'wheel'];
const PAGE = '<!doctype html><meta charset="utf-8"><title>Bubble</title><script>'
  + 'window.seen = []; const note = (what) => seen.push(what);'
  + 'for (const type of ' + JSON.stringify(WATCHED) + ') { window.addEventListener(type, () => note("window:" + type), { capture: true, passive: false });'
  + ' document.addEventListener(type, () => note("document:" + type), { capture: true, passive: false }); }'
  + 'document.addEventListener("visibilitychange", () => note("visibilitychange:" + document.visibilityState));'
  + 'window.addEventListener("pagehide", () => note("pagehide"));'
  + 'window.lostFocus = 0; setInterval(() => { if (!document.hasFocus()) lostFocus++; }, 20);'
  + 'window.occluded = [];'
  + 'document.addEventListener("DOMContentLoaded", () => {'
  + ' new IntersectionObserver((entries) => { for (const entry of entries) occluded.push(entry.isVisible); },'
  + '  { trackVisibility: true, delay: 100 }).observe(document.getElementById("mid"));'
  + ' window.channel = new BroadcastChannel("rooks"); });'
  + '</script><style>body{margin:0;height:3000px;position:relative;font:16px sans-serif}'
  + '#top,#mid,#edge,#low{position:absolute;margin:0;width:160px;height:40px;background:#cde}'
  + '#top{left:10px;top:10px}#mid{left:400px;top:200px}#edge{right:0;top:400px}#low{left:400px;top:1200px}</style>'
  + '<button id="top">Top</button><button id="mid">Middle</button><button id="edge">Edge</button><button id="low">Low</button>';
const UI = '<!doctype html><meta charset="utf-8"><title>Rooks</title><body style="margin:0;background:#223"><script>'
  + 'window.seen = []; for (const type of ["focus", "blur", "keydown"]) window.addEventListener(type, () => seen.push(type), true);'
  + '</script>';

(async () => {
  await app.whenReady();
  app.dock?.hide();
  report.display = { scaleFactor: screen.getPrimaryDisplay().scaleFactor };
  const { NativeBrowserEngine } = await import('./native-browser.js');
  const engine = new NativeBrowserEngine(home);
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const command = (action, params = {}) => engine.command({ profileId: 'bubble', action, ...params });
  const human = { commandActor: 'human' };
  const profile = () => engine.profiles.get('bubble');
  const activeTab = () => profile().tabs.get(profile().activeTabId);
  const waitFor = async (what, predicate) => {
    for (let i = 0; i < 200; i++) { const found = await predicate(); if (found) return found; await delay(25); }
    throw new Error('Timed out waiting for ' + what);
  };
  const frames = contents => contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const js = (contents, expression) => contents.executeJavaScript(expression);
  const click = async (contents, x, y) => {
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await delay(80);
  };
  const key = (contents, keyCode, modifiers = []) => {
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1 || keyCode === 'Enter') contents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : keyCode, modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  const type = async (contents, text) => { for (const letter of text) key(contents, letter); await delay(60); };
  const memoryOf = (pid) => app.getAppMetrics().find(metric => metric.pid === pid)?.memory.workingSetSize ?? null;

  // The window that presents the browser, as the Rooks UI does: the page's view sits on its content.
  const PANEL = { x: 240, y: 60 };
  const ui = new BrowserWindow({ show: false, x: 0, y: 0, width: VIEW.width + 400, height: VIEW.height + 120, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await ui.loadURL('data:text/html,' + encodeURIComponent(UI));
  // Shown and focused: a hidden window paints nothing and focuses no view, which is what is measured here.
  ui.show();
  ui.focus();
  await delay(300);
  let presentation = null;
  const attach = async (width, height, at = PANEL) => {
    const { viewToken } = await command('presentation');
    presentation = { x: at.x, y: at.y, width, height };
    engine.attach(ui, { profileId: 'bubble', viewToken, bounds: presentation });
  };

  // ---- The spike's bubble manager: what volet 1 would put in native-browser.ts ----------------------
  const bubbleSession = session.fromPartition('rooks-annotation-bubble');
  const bubblePreload = join(home, 'bubble-preload.cjs');
  const bubbleEvents = [];
  const rejected = [];
  let bubble = null;
  let waiter = null;
  const anchors = [];
  const blurs = [];
  ipcMain.on('rooks:spike-bubble', (event, message) => {
    if (!bubble || event.sender !== bubble.view.webContents || event.senderFrame !== event.sender.mainFrame) {
      rejected.push(message && message.type);
      return;
    }
    bubbleEvents.push(message);
    if (waiter && waiter.type === message.type) { const resolve = waiter.resolve; waiter = null; resolve(message); }
  });
  ipcMain.on('rooks:spike-anchor-rect', (event, rect) => {
    if (event.sender !== activeTab().view.webContents) return;
    anchors.push(rect);
    if (bubble) place(rect);
  });
  const next = (type) => new Promise((resolve, reject) => {
    waiter = { type, resolve };
    setTimeout(() => reject(new Error('Bubble never sent ' + type)), 5000).unref();
  });
  /** Below the element, above it if there is no room, clamped inside the page's panel; window coordinates. */
  const placement = (rect) => {
    const below = rect.y + rect.height + BUBBLE.gap;
    const y = below + BUBBLE.height <= presentation.height ? below : Math.max(0, rect.y - BUBBLE.gap - BUBBLE.height);
    const x = Math.min(Math.max(0, rect.x), presentation.width - BUBBLE.width);
    return { x: presentation.x + Math.round(x), y: presentation.y + Math.round(y), width: BUBBLE.width, height: BUBBLE.height };
  };
  // An element scrolled out of the panel takes its bubble along; it comes back with it.
  const inView = (rect) => rect.y + rect.height > 0 && rect.y < presentation.height && rect.x + rect.width > 0 && rect.x < presentation.width;
  const place = (rect) => { bubble.anchor = rect; bubble.view.setBounds(placement(rect)); bubble.visible = inView(rect); bubble.view.setVisible(bubble.visible); };
  const createView = async () => {
    const view = new WebContentsView({ webPreferences: { session: bubbleSession, preload: bubblePreload, sandbox: true,
      contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false,
      backgroundThrottling: false, spellcheck: false, navigateOnDragDrop: false } });
    view.setBackgroundColor('#00000000');
    view.webContents.on('blur', () => { blurs.push(view.webContents.id); });
    view.webContents.on('will-navigate', event => event.preventDefault());
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await view.webContents.loadURL('data:text/html;base64,' + Buffer.from(BUBBLE_HTML).toString('base64'));
    return view;
  };
  let spare = null;
  /** Shows the bubble on a picked element; reuse keeps one view and its renderer between bubbles. */
  const openBubble = async (rect, point, label, { reuse = false } = {}) => {
    const started = performance.now();
    const view = reuse && spare ? spare : await createView();
    spare = null;
    bubble = { view, anchor: rect };
    ui.contentView.addChildView(view);
    place(rect);
    view.setVisible(true);
    view.webContents.focus();
    const ready = next('ready');
    view.webContents.send('rooks:spike-bubble-show', { label });
    const state = (await ready).state;
    activeTab().view.webContents.send('rooks:spike-anchor', point);
    return { ms: performance.now() - started, state, pid: view.webContents.getOSProcessId() };
  };
  /** Removes the view and gives the keyboard back to the page, where annotate mode's Escape lives. */
  const closeBubble = ({ keep = false } = {}) => {
    const view = bubble.view;
    const contents = view.webContents;
    bubble = null;
    activeTab().view.webContents.send('rooks:spike-anchor', null);
    ui.contentView.removeChildView(view);
    if (keep) { view.setVisible(false); spare = view; } else contents.close();
    activeTab().view.webContents.focus();
    return { view, contents };
  };
  const order = () => {
    const children = ui.contentView.children;
    return { page: children.indexOf(activeTab().view), bubble: bubble ? children.indexOf(bubble.view) : -1, count: children.length };
  };
  const focusState = () => ({ ui: ui.webContents.isFocused(), page: activeTab().view.webContents.isFocused(),
    bubble: bubble ? bubble.view.webContents.isFocused() : null });
  const pageNoticed = async () => ({ seen: await js(page, 'seen.splice(0)'), lostFocus: await js(page, 'lostFocus'),
    hasFocus: await js(page, 'document.hasFocus()'), visibility: await js(page, 'document.visibilityState'),
    occluded: await js(page, 'occluded.filter(visible => !visible).length') });
  const status = async () => (await command('status')).annotation;
  const pick = async (x, y) => {
    const before = (await status()).pending;
    await click(page, x, y);
    await waitFor('pick at ' + x + ',' + y, async () => (await status()).pending > before);
    const picks = (await command('annotateCollect', human)).annotation.picks;
    return picks[picks.length - 1];
  };

  let page;
  try {
    await command('start');
    await command('resize', { width: VIEW.width, height: VIEW.height, mobile: false });
    await command('navigate', { url: origin + '/' });
    await waitFor('page', () => activeTab().view.webContents.getURL().startsWith(origin) && !activeTab().view.webContents.isLoading());
    await attach(VIEW.width, VIEW.height);
    page = activeTab().view.webContents;
    await frames(page);
    report.checks.attached = { bounds: activeTab().view.getBounds(), order: order(), pageDpr: await js(page, 'devicePixelRatio'),
      pageInner: await js(page, '({ width: innerWidth, height: innerHeight })') };

    // ---- 1 + 2 + 3. A first bubble, typed into and sent -------------------------------------------
    await command('annotateStart', human);
    await js(page, 'seen.splice(0); true');
    const mid = await pick(420, 210);
    report.checks.clickFocus = focusState();
    const first = await openBubble(mid.rect, mid.point, '1');
    report.checks.first = { ms: first.ms, state: first.state, order: order(), bounds: bubble.view.getBounds(), rect: mid.rect,
      focus: focusState() };
    await delay(300);
    report.checks.first.noticed = await pageNoticed();
    await type(bubble.view.webContents, 'Hello');
    key(bubble.view.webContents, 'Enter', ['shift']);
    await type(bubble.view.webContents, 'World');
    const submitted = next('submit');
    key(bubble.view.webContents, 'Enter');
    report.checks.first.submit = (await submitted).text;
    report.checks.first.typedNoticed = await pageNoticed();
    report.checks.first.uiSeen = await js(ui.webContents, 'seen.splice(0)');
    const closedFirst = closeBubble();
    await delay(150);
    report.checks.first.afterClose = { order: order(), destroyed: closedFirst.contents.isDestroyed(),
      viewContents: closedFirst.view.webContents === undefined ? 'undefined' : 'kept', focus: focusState(),
      pidAlive: memoryOf(first.pid) !== null, noticed: await pageNoticed(), annotating: (await status()).active };

    // ---- 3. Escape cancels; the next bubble is another view --------------------------------------
    const top = await pick(20, 20);
    const second = await openBubble(top.rect, top.point, '2');
    await type(bubble.view.webContents, 'Draft');
    const cancelled = next('cancel');
    key(bubble.view.webContents, 'Escape');
    await cancelled;
    report.checks.escape = { cancelled: true, samePid: second.pid === first.pid, noticed: await pageNoticed(),
      annotatingWhileOpen: (await status()).active };
    closeBubble();
    // The keyboard is back on the page: a second Escape reaches its preload and leaves annotate mode.
    key(page, 'Escape');
    await waitFor('annotate mode ended', async () => !(await status()).active);
    report.checks.escape.second = { stoppedReason: (await status()).stoppedReason, noticed: await pageNoticed() };
    await command('annotateStart', human);

    // ---- 4. A click inside the bubble points at nothing; a click on the page moves on --------------
    const third = await openBubble(mid.rect, mid.point, '3');
    const pendingBefore = (await status()).pending;
    await click(bubble.view.webContents, 40, 60);
    await delay(300);
    report.checks.clickInBubble = { pendingBefore, pendingAfter: (await status()).pending, focus: focusState(),
      noticed: await pageNoticed(), bubbleLog: await js(bubble.view.webContents, 'log.splice(0)') };
    // sendInputEvent moves no focus; an OS click on the page's view would: page.focus() stands for it.
    blurs.splice(0);
    await click(page, 30, 25);
    await waitFor('pick while a bubble is open', async () => (await status()).pending > pendingBefore);
    const clickOnly = focusState();
    page.focus();
    await delay(100);
    report.checks.clickOnPage = { clickOnly, osFocus: focusState(), bubbleBlurs: blurs.length,
      bubbleLog: await js(bubble.view.webContents, 'log.splice(0)'), noticed: await pageNoticed() };
    await command('annotateCollect', human);
    bubble.view.webContents.focus();
    await delay(50);

    // ---- 2. The page cannot find or reach the bubble -----------------------------------------------
    await js(page, 'channel.postMessage("from-page"); true');
    await delay(200);
    report.checks.reach = {
      pageGlobals: await js(page, '({ bridge: typeof window.rooksBubble, require: typeof window.require, frames: window.length,'
        + ' top: window.top === window, opener: window.opener === null })'),
      bubbleChannel: await js(bubble.view.webContents, 'channel.splice(0)'),
      bubbleOrigin: await js(bubble.view.webContents, 'location.origin'),
      bubbleGlobals: await js(bubble.view.webContents, '({ require: typeof window.require, process: typeof window.process,'
        + ' bridge: Object.keys(window.rooksBubble) })'),
      sessions: { pageIsBubble: page.session === bubbleSession, persistent: bubbleSession.isPersistent() },
    };
    // Nor can the bubble's document go anywhere: will-navigate is refused.
    await js(bubble.view.webContents, 'location.href = ' + JSON.stringify(origin + '/') + '; true');
    await delay(200);
    report.checks.reach.bubbleUrl = bubble.view.webContents.getURL().slice(0, 15);
    // The guard itself: a message on the bubble's channel from any other sender (the page, a sub-frame) is dropped.
    ipcMain.emit('rooks:spike-bubble', { sender: page, senderFrame: page.mainFrame }, { type: 'submit', text: 'forged' });
    report.checks.rejected = rejected.slice();

    // ---- 1. Scroll: the anchor follows ------------------------------------------------------------
    const anchoredBefore = anchors.length;
    await js(page, 'window.scrollTo(0, 120); true');
    await waitFor('anchor after scroll', () => anchors.length > anchoredBefore && anchors[anchors.length - 1].y < mid.rect.y - 100);
    await frames(page);
    report.checks.scroll = { rect: anchors[anchors.length - 1], bounds: bubble.view.getBounds(),
      pageRect: await js(page, 'JSON.parse(JSON.stringify(document.getElementById("mid").getBoundingClientRect()))'),
      noticed: await pageNoticed() };
    await js(page, 'window.scrollTo(0, 1000); true');
    await waitFor('anchor out of view', () => anchors[anchors.length - 1].y < -500);
    report.checks.scroll.visibleOutOfView = bubble.visible;
    await js(page, 'window.scrollTo(0, 0); true');
    await waitFor('anchor back', () => anchors[anchors.length - 1].y === mid.rect.y);
    report.checks.scroll.backInView = { visible: bubble.visible, bounds: bubble.view.getBounds() };
    closeBubble();
    await frames(page);

    // ---- 1. Edge of the viewport ----------------------------------------------------------------
    const edge = await pick(860, 420);
    await openBubble(edge.rect, edge.point, '4');
    report.checks.edge = { rect: edge.rect, bounds: bubble.view.getBounds(), panel: { ...presentation } };

    // ---- Pitfall: anything that re-presents the page view raises it over the bubble -----------------
    const beforeRepresent = order();
    await command('resize', { width: VIEW.width, height: VIEW.height, mobile: false, ...human });
    report.checks.represent = { before: beforeRepresent, after: order(), focus: focusState() };
    ui.contentView.addChildView(bubble.view);
    bubble.view.webContents.focus();
    report.checks.represent.raised = { order: order(), focus: focusState() };

    // ---- 1. The window is resized: the UI resizes the viewport and attaches again -----------------
    const anchoredBeforeResize = anchors.length;
    ui.setContentSize(SMALL.width + 400, SMALL.height + 120);
    await command('resize', { width: SMALL.width, height: SMALL.height, mobile: false, ...human });
    report.checks.resize = { detached: order().page === -1 };
    await attach(SMALL.width, SMALL.height, { x: 300, y: 80 });
    ui.contentView.addChildView(bubble.view);
    await frames(page);
    // The preload keeps the element: the page's resize event alone brings its new rectangle.
    await waitFor('anchor after resize', () => anchors.length > anchoredBeforeResize && anchors[anchors.length - 1].viewport.width === SMALL.width);
    // The page may report its new rectangle before the UI attaches again: the bubble is placed by the old panel.
    const beforeReplace = bubble.view.getBounds();
    place(anchors[anchors.length - 1]);
    report.checks.resize = { ...report.checks.resize, beforeReplace, rect: anchors[anchors.length - 1], bounds: bubble.view.getBounds(),
      panel: { ...presentation }, order: order(), pageBounds: activeTab().view.getBounds(),
      pageRect: await js(page, 'JSON.parse(JSON.stringify(document.getElementById("edge").getBoundingClientRect()))') };
    closeBubble();
    await command('annotateStop', human);
    ui.setContentSize(VIEW.width + 400, VIEW.height + 120);
    await command('resize', { width: VIEW.width, height: VIEW.height, mobile: false, ...human });
    await attach(VIEW.width, VIEW.height);
    await command('annotateStart', human);

    // ---- 5. Cost: recreated versus reused ----------------------------------------------------------
    const baseline = app.getAppMetrics().length;
    const created = [];
    for (let i = 0; i < 5; i++) {
      const opened = await openBubble(mid.rect, mid.point, 'c' + i);
      created.push({ ms: opened.ms, memory: memoryOf(opened.pid), pid: opened.pid });
      closeBubble();
      await delay(100);
    }
    await delay(500);
    const afterCreated = app.getAppMetrics().length;
    const reused = [];
    for (let i = 0; i < 5; i++) {
      const opened = await openBubble(mid.rect, mid.point, 'r' + i, { reuse: true });
      reused.push({ ms: opened.ms, memory: memoryOf(opened.pid), pid: opened.pid });
      closeBubble({ keep: true });
      await delay(100);
    }
    const kept = spare;
    // Removed from the window but not closed: the renderer stays, until close().
    const keptPid = kept.webContents.getOSProcessId();
    const aliveWhileKept = memoryOf(keptPid) !== null;
    kept.webContents.close();
    spare = null;
    await delay(500);
    report.checks.cost = { created, reused, baseline, afterCreated, aliveWhileKept, goneAfterClose: memoryOf(keptPid) === null,
      pageMemory: memoryOf(page.getOSProcessId()) };
    report.checks.finalNoticed = await pageNoticed();
    report.electron = process.versions.electron;
    console.log('BUBBLE_REPORT ' + JSON.stringify(report));
  } finally {
    await engine.close();
    await new Promise(resolve => server.close(resolve));
  }
  app.exit(0);
})().catch(fail);
`;

interface Rect { x: number; y: number; width: number; height: number }
interface Size { width: number; height: number }
interface Order { page: number; bubble: number; count: number }
interface Focus { ui: boolean; page: boolean; bubble: boolean | null }
interface Noticed { seen: string[]; lostFocus: number; hasFocus: boolean; visibility: string; occluded: number }
interface Anchor extends Rect { viewport: Size }
interface Opened { ms: number; memory: number | null; pid: number }
interface SpikeReport {
  scale: string;
  electron: string;
  display: { scaleFactor: number };
  checks: {
    attached: { bounds: Rect; order: Order; pageDpr: number; pageInner: Size };
    clickFocus: Focus;
    first: {
      ms: number; state: { dpr: number; visibility: string; inner: Size; focused: boolean; hasFocus: boolean };
      order: Order; bounds: Rect; rect: Rect; focus: Focus; noticed: Noticed; submit: string; typedNoticed: Noticed; uiSeen: string[];
      afterClose: { order: Order; destroyed: boolean; viewContents: string; focus: Focus; pidAlive: boolean; noticed: Noticed; annotating: boolean };
    };
    escape: { cancelled: boolean; samePid: boolean; noticed: Noticed; annotatingWhileOpen: boolean; second: { stoppedReason: string; noticed: Noticed } };
    clickInBubble: { pendingBefore: number; pendingAfter: number; focus: Focus; noticed: Noticed; bubbleLog: string[] };
    clickOnPage: { clickOnly: Focus; osFocus: Focus; bubbleBlurs: number; bubbleLog: string[]; noticed: Noticed };
    reach: {
      pageGlobals: { bridge: string; require: string; frames: number; top: boolean; opener: boolean };
      bubbleChannel: string[]; bubbleOrigin: string; bubbleUrl: string;
      bubbleGlobals: { require: string; process: string; bridge: string[] };
      sessions: { pageIsBubble: boolean; persistent: boolean };
    };
    rejected: string[];
    scroll: { rect: Anchor; bounds: Rect; pageRect: Rect; noticed: Noticed; visibleOutOfView: boolean; backInView: { visible: boolean; bounds: Rect } };
    edge: { rect: Rect; bounds: Rect; panel: Rect };
    represent: { before: Order; after: Order; focus: Focus; raised: { order: Order; focus: Focus } };
    resize: { detached: boolean; beforeReplace: Rect; rect: Anchor; bounds: Rect; panel: Rect; order: Order; pageBounds: Rect; pageRect: Rect };
    cost: { created: Opened[]; reused: Opened[]; baseline: number; afterCreated: number; aliveWhileKept: boolean; goneAfterClose: boolean; pageMemory: number | null };
    finalNoticed: Noticed;
  };
}

async function runSpike(scale: '1' | '2'): Promise<SpikeReport> {
  const root = await mkdtemp(join(tmpdir(), 'rooks-bubble-spike-'));
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
    await writeFile(join(root, 'native-browser-preload.cjs'), preload + SPIKE_ANCHOR);
    await writeFile(join(root, 'bubble-preload.cjs'), BUBBLE_PRELOAD);
    new Script(fixture, { filename: 'smoke.cjs' });
    await writeFile(join(root, 'smoke.cjs'), fixture);
    const env: NodeJS.ProcessEnv = { ...process.env, ROOKS_HOME: root, ROOKS_SPIKE_SCALE: scale };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(electron, [join(root, 'smoke.cjs')], {
      env, timeout: 90_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    }).catch((error) => { throw new Error(`Bubble spike failed (${error.code ?? error.signal}): ${error.stdout}\n${error.stderr}`); });
    const line = stdout.split('\n').find((candidate) => candidate.startsWith('BUBBLE_REPORT '));
    assert.ok(line, stdout);
    return JSON.parse(line.slice('BUBBLE_REPORT '.length)) as SpikeReport;
  } finally { await rm(root, { recursive: true, force: true }); }
}

const NOTHING: Noticed = { seen: [], lostFocus: 0, hasFocus: true, visibility: 'visible', occluded: 0 };
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const inside = (rect: Rect, panel: Rect) => rect.x >= panel.x && rect.y >= panel.y
  && rect.x + rect.width <= panel.x + panel.width && rect.y + rect.height <= panel.y + panel.height;

/**
 * Opt-in because this starts a real Electron process. Unlike the other smokes, its window is SHOWN
 * and focused for a few seconds (twice): a hidden window paints nothing (`visibilityState` hidden,
 * no requestAnimationFrame) and focuses no view, which is exactly what this spike measures. Needs a
 * desktop session; at device scale 2 the screen must offer 1300 x 600 DIP.
 */
test('annotation bubble spike: a Rooks view over the page takes the keyboard, follows its element and stays out of reach', {
  skip: process.env.ROOKS_ELECTRON_SMOKE !== '1', timeout: 200_000,
}, async () => {
  const reports: SpikeReport[] = [];
  for (const scale of ['1', '2'] as const) reports.push(await runSpike(scale));
  for (const report of reports) {
    const scale = Number(report.scale);
    const { attached, clickFocus, first, escape, clickInBubble, clickOnPage, reach, scroll, edge, represent, resize, cost } = report.checks;
    const at = `[scale ${scale}]`;
    assert.equal(report.display.scaleFactor, scale, `${at} the forced device scale is in effect`);

    // 1. Geometry. The engine forces deviceScaleFactor 1 and a viewport equal to the panel: one page
    // CSS pixel is one window DIP at any screen scale, so a page rect plus the panel's origin is the
    // bubble's place. The bubble itself renders at the screen's scale (crisp text at 2x).
    assert.deepEqual(attached.bounds, { x: 240, y: 60, width: 900, height: 480 });
    assert.deepEqual([attached.pageDpr, attached.pageInner], [1, { width: 900, height: 480 }], `${at} page CSS px = DIP`);
    assert.deepEqual([first.state.dpr, first.state.inner], [scale, { width: 280, height: 132 }], `${at} bubble CSS px = DIP, rendered at the screen scale`);
    assert.deepEqual(first.rect, { x: 400, y: 200, width: 160, height: 40 });
    assert.deepEqual(first.bounds, { x: 240 + 400, y: 60 + 200 + 40 + 8, width: 280, height: 132 }, `${at} below the element, window coordinates`);
    assert.equal(first.order.bubble, first.order.count - 1, `${at} the bubble is the last child: drawn above the page`);
    assert.ok(first.order.page >= 0 && first.order.page < first.order.bubble);
    assert.equal(first.state.visibility, 'visible');

    // Scroll: the anchor tracker reports the element's new rect, the bubble follows, hides off view, comes back.
    assert.deepEqual([scroll.rect.y, scroll.pageRect.y], [80, 80], `${at} the anchor reports the scrolled rect`);
    assert.deepEqual(scroll.bounds, { x: 640, y: 60 + 80 + 48, width: 280, height: 132 });
    assert.equal(scroll.visibleOutOfView, false, `${at} element scrolled out: bubble hidden`);
    assert.deepEqual(scroll.backInView, { visible: true, bounds: first.bounds });
    // Edge: clamped to the panel's right side and flipped above an element with no room below.
    assert.deepEqual(edge.rect, { x: 725, y: 400, width: 160, height: 40 }, `${at} #edge, right:0 left of a 15 px scrollbar`);
    assert.deepEqual(edge.bounds, { x: 240 + 900 - 280, y: 60 + 400 - 8 - 132, width: 280, height: 132 });
    assert.ok(inside(edge.bounds, edge.panel));
    // Pitfall: the engine's presentActive() re-adds the page view, which then covers the bubble.
    assert.ok(represent.before.bubble > represent.before.page);
    assert.ok(represent.after.page > represent.after.bubble, `${at} after a re-present the page is on top: ${JSON.stringify(represent.after)}`);
    assert.ok(represent.raised.order.bubble > represent.raised.order.page, `${at} addChildView again raises the bubble`);
    assert.equal(represent.raised.focus.bubble, true, `${at} and it keeps the keyboard`);
    // Window resized: the UI re-attaches a smaller panel elsewhere; the anchor's new rect can arrive
    // before that, so the bubble must be placed again on attach.
    assert.equal(resize.detached, true, `${at} resizing the viewport detaches the panel`);
    assert.deepEqual(resize.beforeReplace, edge.bounds, `${at} stale until placed again`);
    assert.deepEqual(resize.pageBounds, { x: 300, y: 80, width: 800, height: 420 });
    assert.deepEqual([resize.rect.x, resize.rect.y, resize.rect.viewport], [resize.pageRect.x, resize.pageRect.y, { width: 800, height: 420 }]);
    assert.deepEqual(resize.bounds, { x: 300 + 800 - 280, y: 80 + 400 - 8 - 132, width: 280, height: 132 });
    assert.ok(inside(resize.bounds, resize.panel));
    assert.equal(resize.order.bubble, resize.order.count - 1);

    // 2. Focus. sendInputEvent moves no focus (control: the window holds it, not the page).
    assert.deepEqual([clickFocus.ui, clickFocus.page], [true, false], `${at} control: ${JSON.stringify(clickFocus)}`);
    assert.deepEqual(first.focus, { ui: false, page: false, bubble: true }, `${at} webContents.focus() gives the bubble the window's keys`);
    assert.deepEqual([first.state.focused, first.state.hasFocus], [true, true], `${at} the textarea is focused`);
    // Control: a contents of the same window without focus emulation does see the focus leave.
    assert.ok(first.uiSeen.includes('blur'), `${at} control: ${first.uiSeen}`);
    // The page sees nothing: no key, no focus/blur, hasFocus() never false (the engine's
    // Emulation.setFocusEmulationEnabled), still visible, and IntersectionObserver v2 sees no occlusion.
    for (const noticed of [first.noticed, first.typedNoticed, first.afterClose.noticed, escape.noticed, clickInBubble.noticed,
      clickOnPage.noticed, scroll.noticed, report.checks.finalNoticed]) assert.deepEqual(noticed, NOTHING, `${at} ${JSON.stringify(noticed)}`);
    assert.deepEqual(reach.pageGlobals, { bridge: 'undefined', require: 'undefined', frames: 0, top: true, opener: true }, `${at} nothing to reach`);
    assert.deepEqual(reach.bubbleChannel, [], `${at} a BroadcastChannel post of the page never reaches the bubble`);
    assert.equal(reach.bubbleOrigin, 'null', `${at} data: = opaque origin`);
    assert.deepEqual(reach.sessions, { pageIsBubble: false, persistent: false }, `${at} its own in-memory session`);
    assert.deepEqual(reach.bubbleGlobals, { require: 'undefined', process: 'undefined', bridge: ['submit', 'cancel', 'ready', 'onShow'] });
    assert.equal(reach.bubbleUrl, 'data:text/html;', `${at} the bubble cannot navigate`);
    assert.deepEqual(report.checks.rejected, ['submit'], `${at} a message from another sender is dropped`);

    // 3. Keys and closing.
    assert.equal(first.submit, 'Hello\nWorld', `${at} Shift+Enter breaks the line, Enter sends`);
    assert.deepEqual(first.afterClose.order, { page: 0, bubble: -1, count: 1 }, `${at} the view is removed`);
    assert.deepEqual([first.afterClose.destroyed, first.afterClose.viewContents, first.afterClose.pidAlive], [true, 'undefined', false],
      `${at} webContents.close() ends its renderer; the view then has no webContents`);
    assert.equal(first.afterClose.focus.page, true, `${at} the keyboard goes back to the page`);
    assert.equal(first.afterClose.annotating, true, `${at} annotate mode survives a bubble`);
    assert.equal(escape.cancelled, true);
    assert.equal(escape.annotatingWhileOpen, true, `${at} Escape in the bubble closes the bubble only`);
    assert.equal(escape.samePid, false, `${at} a new view is a new renderer`);
    assert.deepEqual([escape.second.stoppedReason, escape.second.noticed.seen], ['escape', []], `${at} a second Escape leaves annotate mode`);

    // 4. Annotate mode. A click in the bubble is the bubble's: no pick, the page sees nothing.
    assert.equal(clickInBubble.pendingAfter, clickInBubble.pendingBefore, `${at} a click in the bubble picks nothing`);
    assert.equal(clickInBubble.focus.bubble, true);
    // A click on the page still picks; the real (OS) click would move the focus there, and main hears the bubble's blur.
    assert.deepEqual(clickOnPage.clickOnly, { ui: false, page: false, bubble: true });
    assert.deepEqual(clickOnPage.osFocus, { ui: false, page: true, bubble: false });
    assert.equal(clickOnPage.bubbleBlurs, 1, `${at} webContents 'blur' tells main the bubble lost the keyboard`);
    assert.deepEqual(clickOnPage.bubbleLog, ['window:blur']);

    // 5. Cost. One renderer per view; reuse skips its start. Bounds are loose: timings vary with load.
    assert.equal(new Set(cost.created.map(opened => opened.pid)).size, cost.created.length, `${at} each created view, its process`);
    assert.equal(new Set(cost.reused.map(opened => opened.pid)).size, 1, `${at} a reused view keeps one process`);
    assert.equal(cost.afterCreated, cost.baseline, `${at} closed views leave no process behind`);
    assert.deepEqual([cost.aliveWhileKept, cost.goneAfterClose], [true, true], `${at} removeChildView alone keeps the renderer`);
    const createdMs = median(cost.created.slice(1).map(opened => opened.ms));
    const reusedMs = median(cost.reused.slice(1).map(opened => opened.ms));
    assert.ok(reusedMs < createdMs, `${at} reused ${reusedMs} ms < created ${createdMs} ms`);
    assert.ok(Math.max(...cost.created.map(opened => opened.ms)) < 2_000, `${at} a cold bubble shows within 2 s`);
    assert.ok(cost.created.every(opened => typeof opened.memory === 'number' && opened.memory > 0));
    console.log(`${at} show: first ${Math.round(first.ms)} ms, created ${Math.round(createdMs)} ms, reused ${reusedMs.toFixed(1)} ms;`
      + ` bubble renderer ${Math.round(median(cost.created.map(opened => opened.memory!)) / 1024)} MB working set,`
      + ` page ${Math.round((cost.pageMemory ?? 0) / 1024)} MB (Electron ${report.electron})`);
  }
  // The same window geometry at both scales: DIP, not device pixels.
  assert.deepEqual(reports[0]!.checks.first.bounds, reports[1]!.checks.first.bounds);
  assert.deepEqual(reports[0]!.checks.resize.bounds, reports[1]!.checks.resize.bounds);
});
