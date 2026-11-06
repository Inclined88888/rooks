import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Script } from 'node:vm';
import ts from 'typescript';

/**
 * Spike for TODO #468 (annotating the built-in browser). Nothing here ships: the real preload is
 * compiled as is and a throwaway annotator is appended to it in the temp copy only.
 *
 * 1. the preload swallows every pointer gesture before the page sees it;
 * 2. framework expandos (`__reactFiber$…`) are invisible to the preload's isolated world, readable
 *    over CDP without Runtime.enable, and which reads stay passive (no page code runs);
 * 3. the coordinate space of `Page.captureScreenshot`'s `clip` on a scrolled page;
 * 4. `Overlay.highlightRect`: what it needs, what it costs;
 * 5. the source file each framework leaves on its DOM nodes (React 18 and 19 really mounted from the
 *    copies already installed by app/ and public-docs/; Vue and Svelte only as the shape they leave).
 *
 * "Human" input is `webContents.sendInputEvent` (no debugger), as in the #461 spike. Touch has no
 * sendInputEvent form: it goes through `Input.dispatchTouchEvent`, which the page sees as trusted too.
 */

const MODULES = ['native-browser', 'native-browser-protocol', 'native-browser-credentials', 'native-browser-user-agent',
  'native-browser-devtools', 'native-browser-cookies', 'native-browser-chrome', 'native-browser-chrome-signin', 'native-browser-recorder', 'native-browser-annotator'];

/** Appended to the compiled production preload: the shape task 1 would give the real annotator. */
const SPIKE_ANNOTATOR = String.raw`
;(() => {
  const { ipcRenderer: annotateIpc } = require('electron');
  let annotating = annotateIpc.sendSync('timon:spike-annotate-state') === true;
  annotateIpc.on('timon:spike-annotate-toggle', (_event, on) => { annotating = on === true; });
  const SWALLOWED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu',
    'touchstart', 'touchmove', 'touchend', 'touchcancel'];
  const swallow = (event) => {
    if (!annotating) return;
    event.stopImmediatePropagation();
    if (event.cancelable) event.preventDefault();
    const target = event.composedPath()[0];
    annotateIpc.send('timon:spike-annotate-event', { type: event.type, target: (target && target.id) || String(target && target.nodeName),
      trusted: event.isTrusted, prevented: event.defaultPrevented });
  };
  // Chromium makes window-level touchstart/touchmove listeners passive unless told otherwise.
  for (const type of SWALLOWED) window.addEventListener(type, swallow, { capture: true, passive: false });
  annotateIpc.on('timon:spike-annotate-expandos', (_event, selector) => {
    const element = document.querySelector(selector);
    annotateIpc.send('timon:spike-annotate-expandos', element ? { found: true,
      names: Object.getOwnPropertyNames(element).filter((name) => name.startsWith('__')),
      vue: '__vueParentComponent' in element, svelte: '__svelte_meta' in element } : { found: false });
  });
  window.addEventListener('load', () => annotateIpc.send('timon:spike-annotate-hello', { url: location.href }));
})();
`;

/** Every test page carries the classic Runtime.enable tell: a console argument whose `stack` getter runs only when serialised. */
const RUNTIME_TELL = String.raw`
window.__runtimeTell = 0;
window.__tellTimer = setInterval(() => {
  const probe = new Error('tell');
  Object.defineProperty(probe, 'stack', { configurable: true, get() { window.__runtimeTell++; return ''; } });
  console.debug(probe);
}, 40);
`;

const fixture = String.raw`
const { app, dialog, ipcMain, nativeImage } = require('electron');
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const home = process.env.TIMON_HOME;
const FILES = JSON.parse(process.env.TIMON_SPIKE_FILES);
const report = { checks: {} };
const fail = (error) => { require('node:fs').writeSync(2, String(error?.stack ?? error) + '\nPARTIAL ' + JSON.stringify(report) + '\n'); app.exit(1); };
dialog.showErrorBox = (title, content) => fail(title + '\n' + content);
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
app.setPath('userData', join(home, 'shell'));
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const TELL = ${JSON.stringify(RUNTIME_TELL)};
const head = (title) => '<!doctype html><meta charset="utf-8"><title>' + title + '</title><script>' + TELL + '</script>';

const GESTURE_TYPES = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu', 'touchstart', 'touchend'];
const ANNOTATE_PAGE = head('Annotate')
  // The earliest a page can listen: capture on window and document, from an inline script in <head>.
  + '<script>window.seen = []; const types = ' + JSON.stringify(GESTURE_TYPES) + ';'
  + 'for (const type of types) { window.addEventListener(type, () => seen.push("window:" + type), { capture: true, passive: false });'
  + ' document.addEventListener(type, () => seen.push("document:" + type), { capture: true, passive: false }); }</script>'
  + '<style>body{margin:0;font:16px sans-serif}#field,#menu,#check,#details,#link,#text,#btn{position:absolute;left:20px;width:200px;height:30px;margin:0;display:block}'
  + '#field{top:20px}#menu{top:70px}#check{top:120px;width:30px}#details{top:170px}#link{top:220px}#text{top:270px}#btn{top:320px}</style>'
  + '<input id="field"><div id="menu">Menu</div><input id="check" type="checkbox">'
  + '<details id="details"><summary id="summary">More</summary>Hidden</details>'
  + '<a id="link" href="/elsewhere">Link</a><p id="text">wordone wordtwo</p><button id="btn">Button</button>'
  // A menu that opens on pointerdown, as many component libraries do.
  + '<script>menu.addEventListener("pointerdown", () => { menu.dataset.open = "1"; });</script>';

// 60 rows × 30 columns of 50 px cells; a cell's colour encodes its position: rgb(col*8, row*4, 77).
const CLIP_PAGE = head('Clip') + '<style>body{margin:0;width:1500px;height:3000px;position:relative}.c{position:absolute;width:50px;height:50px}</style>'
  + '<script>document.addEventListener("DOMContentLoaded", () => { for (let r = 0; r < 60; r++) for (let c = 0; c < 30; c++) {'
  + ' const cell = document.createElement("div"); cell.className = "c"; cell.id = "c-" + c + "-" + r;'
  + ' cell.style.cssText = "left:" + c * 50 + "px;top:" + r * 50 + "px;background:rgb(" + c * 8 + "," + r * 4 + ",77)";'
  + ' document.body.appendChild(cell); } });</script>';

const REACT18_PAGE = head('React 18') + '<div id="root"></div><script src="/r18/react.js"></script><script src="/r18/react-dom.js"></script>'
  + '<script src="/src/App18.js"></script>';
// What Babel's jsx-source transform (Vite + plugin-react, CRA) adds to every element in development.
const APP18 = 'function Card() {\n'
  + '  return React.createElement("button", { id: "target", __source: { fileName: "/home/dev/app/src/Card.jsx", lineNumber: 4, columnNumber: 10 } }, "React 18");\n'
  + '}\n'
  + 'ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(Card, { __source: { fileName: "/home/dev/app/src/main.jsx", lineNumber: 9, columnNumber: 3 } }));\n';

// React 19 ships CommonJS only: a twenty-line synchronous require is enough to mount it without a bundler.
const REACT19_PAGE = head('React 19') + '<div id="root"></div><script>'
  + 'const MODULES = { react: "/r19/react.js", "react/jsx-dev-runtime": "/r19/jsx-dev-runtime.js", "react-dom": "/r19/react-dom.js",'
  + ' "react-dom/client": "/r19/react-dom-client.js", scheduler: "/r19/scheduler.js" };'
  + 'const cache = {};'
  + 'window.require19 = function require19(name) {'
  + ' if (cache[name]) return cache[name].exports;'
  + ' const request = new XMLHttpRequest(); request.open("GET", MODULES[name], false); request.send();'
  + ' const module = { exports: {} }; cache[name] = module;'
  + ' new Function("module", "exports", "require", "process", request.responseText + "\\n//# sourceURL=" + location.origin + MODULES[name])'
  + '  (module, module.exports, require19, { env: { NODE_ENV: "development" } });'
  + ' return module.exports; };'
  + '</script><script src="/src/App19.js"></script>';
// What the automatic runtime emits in development (Vite + plugin-react, Next): jsxDEV with a source React 19 ignores.
const APP19 = 'const { jsxDEV } = require19("react/jsx-dev-runtime");\n'
  + 'const { createRoot } = require19("react-dom/client");\n'
  + 'function Card() {\n'
  + '  return jsxDEV("button", { id: "target", children: "React 19" }, undefined, false, { fileName: "/home/dev/app/src/Card.tsx", lineNumber: 4, columnNumber: 10 }, this);\n'
  + '}\n'
  + 'createRoot(document.getElementById("root")).render(jsxDEV(Card, {}, undefined, false, undefined, this));\n';

// Vue 3 and Svelte 5 are not installed anywhere in the repository: only the expando shape their dev
// builds leave (Vue defines it non-enumerable), to prove the passive reader walks it.
const SHAPES_PAGE = head('Shapes') + '<button id="vue">Vue</button><button id="svelte">Svelte</button><script>'
  + 'Object.defineProperty(document.getElementById("vue"), "__vueParentComponent", { value: { uid: 1, type: { __name: "Card", __file: "/home/dev/app/src/components/Card.vue" } }, enumerable: false, configurable: true, writable: true });'
  + 'document.getElementById("svelte").__svelte_meta = { loc: { file: "src/lib/Card.svelte", line: 3, column: 2 } };'
  + '</script>';

// A page that booby-traps every way of reading its expando: Proxy traps, getters, patched builtins, prepareStackTrace.
const HOSTILE_PAGE = head('Hostile') + '<button id="target">Hostile</button><script>'
  + 'window.__pageCalls = []; const bump = (what) => { window.__pageCalls.push(what); };'
  + 'Error.prepareStackTrace = () => { bump("prepareStackTrace"); return "prepared"; };'
  + 'const stack = new Error("debug stack");'
  + 'const fiberTarget = { type: "button", _debugStack: stack, _debugSource: { fileName: "/home/dev/app/src/Hostile.tsx", lineNumber: 1, columnNumber: 1 } };'
  + 'Object.defineProperty(fiberTarget, "_debugOwner", { get() { bump("getter:_debugOwner"); return null; }, enumerable: true });'
  + 'const trap = (name, real) => function (...args) { bump("proxy:" + name); return real(...args); };'
  + 'const fiber = new Proxy(fiberTarget, { get: trap("get", Reflect.get), getOwnPropertyDescriptor: trap("getOwnPropertyDescriptor", Reflect.getOwnPropertyDescriptor),'
  + ' ownKeys: trap("ownKeys", Reflect.ownKeys), has: trap("has", Reflect.has) });'
  + 'const element = document.getElementById("target"); element.__reactFiber$hostile = fiber;'
  + 'Object.defineProperty(element, "__reactProps$hostile", { get() { bump("getter:__reactProps"); return {}; }, enumerable: true });'
  + 'const realKeys = Object.keys; Object.keys = function (value) { bump("Object.keys"); return realKeys(value); };'
  + '</script>';

/** The design's reader: one function evaluated in the page's main world. */
const CALL_FUNCTION_READER = 'function () {'
  + ' const key = Object.keys(this).find((name) => name.startsWith("__reactFiber$"));'
  + ' const fiber = key ? this[key] : null; const source = fiber && fiber._debugSource;'
  + ' return { key: key || null, file: source ? source.fileName : null, line: source ? source.lineNumber : null,'
  + '  owner: fiber && fiber._debugOwner && fiber._debugOwner.type ? fiber._debugOwner.type.name : null,'
  + '  stack: fiber && fiber._debugStack ? String(fiber._debugStack.stack).slice(0, 600) : null }; }';

(async () => {
  await app.whenReady();
  app.dock?.hide();
  const hellos = [];
  const swallowed = [];
  let annotating = false;
  let isolated = null;
  ipcMain.on('timon:spike-annotate-state', (event) => { event.returnValue = annotating; });
  ipcMain.on('timon:spike-annotate-event', (_event, payload) => { swallowed.push(payload); });
  ipcMain.on('timon:spike-annotate-hello', (event, payload) => { hellos.push({ ...payload, contents: event.sender }); });
  ipcMain.on('timon:spike-annotate-expandos', (_event, payload) => { isolated = payload; });
  const { NativeBrowserEngine } = await import('./native-browser.js');
  const engine = new NativeBrowserEngine(home);
  const PAGES = { '/annotate': ANNOTATE_PAGE, '/clip': CLIP_PAGE, '/react18': REACT18_PAGE, '/react19': REACT19_PAGE,
    '/shapes': SHAPES_PAGE, '/hostile': HOSTILE_PAGE, '/elsewhere': head('Elsewhere') };
  const SCRIPTS = { '/src/App18.js': APP18, '/src/App19.js': APP19 };
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (PAGES[path]) { res.setHeader('Content-Type', 'text/html'); res.end(PAGES[path]); return; }
    if (SCRIPTS[path]) { res.setHeader('Content-Type', 'text/javascript'); res.end(SCRIPTS[path]); return; }
    if (FILES[path]) { res.setHeader('Content-Type', 'text/javascript'); res.end(readFileSync(FILES[path])); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const command = (action, params = {}) => engine.command({ profileId: 'annotate', action, ...params });
  const waitFor = async (what, predicate) => {
    for (let i = 0; i < 200; i++) { const found = await predicate(); if (found) return found; await delay(25); }
    throw new Error('Timed out waiting for ' + what);
  };
  // A fresh document drops input until its first frame is presented; executeJavaScript attaches no debugger.
  const frames = contents => contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const open = async (path) => {
    const url = origin + path;
    const status = await command('status');
    if (status.tabs.length === 1 && status.tabs[0].url === 'about:blank') await command('navigate', { url });
    else await command('newTab', { url });
    const found = await waitFor('hello ' + url, () => [...hellos].reverse().find(h => h.url === url));
    await frames(found.contents);
    return found.contents;
  };
  const page = (contents, expression) => contents.executeJavaScript(expression);
  const send = (contents, method, params) => contents.debugger.sendCommand(method, params);
  const attempt = (promise) => promise.then(result => ({ ok: true, result }), error => ({ ok: false, error: String(error.message ?? error) }));
  const human = {
    click: async (contents, x, y, button = 'left', clickCount = 1) => {
      contents.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount });
      contents.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount });
      await delay(80);
    },
    dblclick: async (contents, x, y) => {
      await human.click(contents, x, y, 'left', 1);
      contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 2 });
      contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 2 });
      await delay(80);
    },
    tap: async (contents, x, y) => {
      await send(contents, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await send(contents, 'Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await send(contents, 'Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await delay(250);
      await send(contents, 'Emulation.setTouchEmulationEnabled', { enabled: false });
    },
  };

  // Passive reader: Runtime.getProperties lists own properties, data values only; a getter is reported, never called.
  const ownProperties = async (contents, objectId) => {
    const { result, internalProperties } = await send(contents, 'Runtime.getProperties', { objectId, ownProperties: true, generatePreview: false });
    return { result, internal: internalProperties ?? [] };
  };
  const resolveAt = async (contents, x, y) => {
    const located = await send(contents, 'DOM.getNodeForLocation', { x, y, includeUserAgentShadowDOM: false });
    const { object } = await send(contents, 'DOM.resolveNode', { backendNodeId: located.backendNodeId, objectGroup: 'timon-annotate' });
    return { backendNodeId: located.backendNodeId, object };
  };
  const read = async (contents, objectId, path) => {
    let current = { objectId };
    const steps = [];
    for (const name of path) {
      if (!current.objectId) return { missing: name, steps };
      const { result, internal } = await ownProperties(contents, current.objectId);
      const property = typeof name === 'function' ? result.find(p => name(p.name)) : result.find(p => p.name === name);
      if (!property) return { missing: String(name), steps, internal: internal.map(p => p.name), names: result.map(p => p.name) };
      steps.push(property.name);
      if (!('value' in property)) return { accessor: property.name, steps };
      current = property.value;
    }
    return { steps, value: current.value, type: current.type, subtype: current.subtype, className: current.className,
      description: current.description, objectId: current.objectId };
  };
  const rectOf = (contents, selector) => page(contents, 'JSON.parse(JSON.stringify(document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect()))');
  const tell = contents => page(contents, 'window.__runtimeTell');

  try {
    await command('start');

    // ---- 3. Captures on a scrolled page --------------------------------------------------------
    const clip = await open('/clip');
    await waitFor('grid', () => page(clip, '!!document.getElementById("c-29-59")'));
    const bounded = (promise, ms) => Promise.race([attempt(promise), delay(ms).then(() => ({ ok: false, error: 'timeout' }))]);
    const imageOf = data => nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
    // Skia's native byte order (BGRA on most platforms): read once from a grid pixel, whose blue is 77.
    let bgra = true;
    const pixel = (image, x, y) => {
      const bitmap = image.toBitmap();
      const at = (y * image.getSize().width + x) * 4;
      return bgra ? { r: bitmap[at + 2], g: bitmap[at + 1], b: bitmap[at] } : { r: bitmap[at], g: bitmap[at + 1], b: bitmap[at + 2] };
    };
    const cellOf = (p) => Math.abs(p.b - 77) <= 3 ? { col: Math.round(p.r / 8), row: Math.round(p.g / 4) } : { r: p.r, g: p.g, b: p.b };
    const centerOf = (image) => ({ size: image.getSize(), cell: cellOf(pixel(image, Math.floor(image.getSize().width / 2), Math.floor(image.getSize().height / 2))) });
    {
      const probe = (await clip.capturePage({ x: 0, y: 0, width: 50, height: 50 })).toBitmap();
      bgra = Math.abs(probe[0] - 77) <= 3;
    }
    const scrollNow = () => page(clip, '({ x: scrollX, y: scrollY })');

    // A page that paints nothing new: lone Page.captureScreenshot calls, then the engine's own 'screenshot'.
    const lone = async (params) => {
      const results = [];
      for (let i = 0; i < 4; i++) results.push((await bounded(send(clip, 'Page.captureScreenshot', params), 3000)).ok ? 'ok' : 'timeout');
      return results;
    };
    const loneStatic = await lone({ format: 'png' });
    const engineScreenshots = [];
    const { width: viewportWidth, height: viewportHeight } = await command('status');
    for (let i = 0; i < 4; i++) {
      const shot = await bounded(command('screenshot'), 20000);
      engineScreenshots.push(shot.ok ? imageOf(shot.result.data).getSize() : shot.error);
    }
    const capturePages = [];
    for (let i = 0; i < 4; i++) capturePages.push((await bounded(clip.capturePage({ x: 0, y: 0, width: 50, height: 50 }), 3000)).ok ? 'ok' : 'timeout');

    await page(clip, 'window.scrollTo(230, 1150); true');
    await frames(clip);
    const metrics = await send(clip, 'Page.getLayoutMetrics');
    const scroll = await scrollNow();
    const rect = await rectOf(clip, '#c-12-30');
    const { pageX, pageY } = metrics.cssVisualViewport;
    const documentRegion = { x: rect.x + pageX, y: rect.y + pageY, width: 50, height: 50 };
    const viewportRegion = { x: rect.x, y: rect.y, width: 50, height: 50 };
    const idOf = async (backendNodeId) => {
      const { node } = await send(clip, 'DOM.describeNode', { backendNodeId });
      const attributes = node.attributes ?? [];
      return attributes[attributes.indexOf('id') + 1] ?? node.nodeName;
    };
    const locate = async (x, y) => {
      const located = await attempt(send(clip, 'DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y) }));
      return located.ok ? await idOf(located.result.backendNodeId) : located.error;
    };
    // Harness only: a handle on the target cell without a hit test.
    const { result: target } = await send(clip, 'Runtime.evaluate', { expression: 'document.getElementById("c-12-30")', objectGroup: 'timon-annotate' });
    const targetNode = (await send(clip, 'DOM.describeNode', { objectId: target.objectId })).node;
    await send(clip, 'Runtime.releaseObjectGroup', { objectGroup: 'timon-annotate' });

    // The same clip, five times in a row: what the protocol answers for a region in view.
    const clipped = async (region) => {
      const answers = [];
      for (let i = 0; i < 5; i++) {
        const answer = await bounded(send(clip, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { ...region, scale: 1 } }), 3000);
        answers.push(answer.ok ? JSON.stringify(centerOf(imageOf(answer.result.data)).cell) : 'timeout');
      }
      return answers;
    };
    const full = await bounded(send(clip, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }), 3000);
    const fullImage = full.ok ? imageOf(full.result.data) : null;
    report.checks.clip = {
      loneStatic, engineScreenshots, engineViewport: { width: viewportWidth, height: viewportHeight }, capturePages, scroll, rect: { x: rect.x, y: rect.y },
      cssVisualViewport: { pageX, pageY, clientWidth: metrics.cssVisualViewport.clientWidth, clientHeight: metrics.cssVisualViewport.clientHeight },
      capturePage: {
        viewportRect: centerOf(await clip.capturePage(viewportRegion)),
        documentRect: centerOf(await clip.capturePage(documentRegion)),
      },
      fullThenCrop: fullImage ? { size: fullImage.getSize(), cell: centerOf(fullImage.crop(viewportRegion)).cell } : full.error,
      clipDocument: await clipped(documentRegion),
      nodeForLocation: { viewportCoords: await locate(rect.x + 25, rect.y + 25), documentCoords: await locate(rect.x + 25 + pageX, rect.y + 25 + pageY) },
      boxModel: (await send(clip, 'DOM.getBoxModel', { backendNodeId: targetNode.backendNodeId })).model.content.slice(0, 2),
    };
    // Last: captureBeyondViewport resizes the page while capturing. What can the page see afterwards?
    await page(clip, 'window.scrollTo(230, 1150); true');
    await frames(clip);
    const pageView = () => page(clip, '({ scroll: [scrollX, scrollY], visual: [visualViewport.pageLeft, visualViewport.pageTop, visualViewport.width, visualViewport.height],'
      + ' inner: [innerWidth, innerHeight], at: (document.elementFromPoint(30, 30) || {}).id || null })');
    const beyondBefore = await pageView();
    const resizes = await page(clip, 'window.__resizes = 0; addEventListener("resize", () => window.__resizes++); 0');
    await bounded(send(clip, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...documentRegion, scale: 1 } }), 3000);
    await bounded(send(clip, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...documentRegion, scale: 1 } }), 3000);
    await frames(clip);
    report.checks.clip.beyondViewport = { before: beyondBefore, after: await pageView(), resizes: resizes + await page(clip, 'window.__resizes') };

    // ---- 4. Overlay.highlightRect -------------------------------------------------------------
    // On a fresh tab: the clip captures above leave the first one's surface in an unknown state.
    // Red square over viewport (10,10)-(70,70); read back by capturePage at viewport (30,30).
    const lit = await open('/clip?overlay');
    await waitFor('overlay grid', () => page(lit, '!!document.getElementById("c-29-59")'));
    const spot = { x: 20, y: 20, width: 20, height: 20 };
    const spotCell = async () => { await frames(lit); return centerOf(await lit.capturePage(spot)).cell; };
    const beforeNodes = await page(lit, 'document.getElementsByTagName("*").length');
    const viewportBefore = await page(lit, '[innerWidth, innerHeight]');
    const events = [];
    const listener = (_event, method) => { if (/^(Overlay|DOM)\./.test(method)) events.push(method); };
    lit.debugger.on('message', listener);
    const highlight = () => attempt(send(lit, 'Overlay.highlightRect', { x: 10, y: 10, width: 60, height: 60, color: { r: 255, g: 0, b: 0, a: 1 } }));
    const overlay = { base: await spotCell() };
    overlay.withoutEnable = await highlight();
    overlay.withoutEnableCell = await spotCell();
    overlay.enableWithoutDom = await attempt(send(lit, 'Overlay.enable'));
    overlay.domEnable = await attempt(send(lit, 'DOM.enable'));
    overlay.enableWithDom = await attempt(send(lit, 'Overlay.enable'));
    overlay.withEnable = await highlight();
    overlay.withEnableCell = await spotCell();
    overlay.hide = await attempt(send(lit, 'Overlay.hideHighlight'));
    overlay.hiddenCell = await spotCell();
    overlay.page = { nodes: [beforeNodes, await page(lit, 'document.getElementsByTagName("*").length')],
      viewport: [viewportBefore, await page(lit, '[innerWidth, innerHeight]')] };
    await send(lit, 'Overlay.disable').catch(() => {});
    await send(lit, 'DOM.disable').catch(() => {});
    lit.debugger.removeListener('message', listener);
    overlay.events = [...new Set(events)];
    overlay.tell = await tell(lit);
    report.checks.overlay = overlay;

    // Control: the tell does fire once Runtime is enabled, so the zeros above are not a dead probe.
    await send(lit, 'Runtime.enable');
    await delay(300);
    report.checks.tellControl = await tell(lit);
    await send(lit, 'Runtime.disable');

    // ---- 1. Swallowing ------------------------------------------------------------------------
    const annotate = await open('/annotate');
    const contextMenus = [];
    annotate.on('context-menu', () => contextMenus.push(Date.now()));
    const snapshot = () => page(annotate, '({ seen: seen.splice(0), focus: document.activeElement && document.activeElement.id || document.activeElement.nodeName,'
      + ' menu: menu.dataset.open === "1", checked: check.checked, details: details.open, path: location.pathname,'
      + ' selection: String(getSelection()) })');
    const gestures = async (withLink) => {
      const steps = {};
      await human.click(annotate, 120, 35); steps.field = await snapshot();
      await human.click(annotate, 120, 85); steps.menu = await snapshot();
      await human.click(annotate, 35, 135); steps.check = await snapshot();
      await human.click(annotate, 40, 182); steps.summary = await snapshot();
      if (withLink) { await human.click(annotate, 40, 235); await delay(300); steps.link = await snapshot(); }
      await human.dblclick(annotate, 40, 282); steps.dblclick = await snapshot();
      const menusBefore = contextMenus.length;
      await human.click(annotate, 120, 335, 'middle'); steps.middle = await snapshot();
      await human.click(annotate, 120, 335, 'right'); await delay(150); steps.right = { ...(await snapshot()), contextMenus: contextMenus.length - menusBefore };
      await human.tap(annotate, 120, 335); steps.tap = await snapshot();
      return steps;
    };
    annotating = true;
    annotate.send('timon:spike-annotate-toggle', true);
    await delay(50);
    const tabsBefore = (await command('status')).tabs.length;
    const on = await gestures(true);
    report.checks.swallow = { on, swallowed: swallowed.splice(0), tabsAfter: (await command('status')).tabs.length - tabsBefore };
    annotating = false;
    annotate.send('timon:spike-annotate-toggle', false);
    await delay(50);
    await page(annotate, 'getSelection().removeAllRanges(); document.activeElement && document.activeElement.blur && document.activeElement.blur(); true');
    report.checks.control = { off: await gestures(false), swallowed: swallowed.splice(0) };
    await command('contextMenuDismiss').catch(() => {});
    report.checks.annotateTell = await tell(annotate);

    // ---- 2 + 5. Expandos, sources --------------------------------------------------------------
    const frameworks = {};
    for (const [name, path] of [['react18', '/react18'], ['react19', '/react19']]) {
      const contents = await open(path);
      await waitFor(name + ' mount', () => page(contents, '!!document.getElementById("target")'));
      const rect = await rectOf(contents, '#target');
      const x = Math.round(rect.x + rect.width / 2); const y = Math.round(rect.y + rect.height / 2);
      isolated = null;
      contents.send('timon:spike-annotate-expandos', '#target');
      await waitFor('isolated expandos', () => isolated);
      const mainWorld = await page(contents, 'Object.getOwnPropertyNames(document.getElementById("target")).filter(n => n.startsWith("__"))');
      const resolved = await attempt(resolveAt(contents, x, y));
      const objectId = resolved.ok ? resolved.result.object.objectId : null;
      const describe = resolved.ok ? await send(contents, 'DOM.describeNode', { backendNodeId: resolved.result.backendNodeId }) : null;
      const isFiber = (n) => n.startsWith('__reactFiber$');
      const passive = objectId ? {
        hostType: await read(contents, objectId, [isFiber, 'type']),
        debugSource: {
          fileName: await read(contents, objectId, [isFiber, '_debugSource', 'fileName']),
          lineNumber: await read(contents, objectId, [isFiber, '_debugSource', 'lineNumber']),
        },
        debugStack: await read(contents, objectId, [isFiber, '_debugStack']),
        debugStackProperty: await read(contents, objectId, [isFiber, '_debugStack', 'stack']),
        owner: await read(contents, objectId, [isFiber, '_debugOwner', 'type', 'name']),
        fiberKeys: (await read(contents, objectId, [isFiber])).objectId
          ? (await ownProperties(contents, (await read(contents, objectId, [isFiber])).objectId)).result.map(p => p.name).filter(n => n.startsWith('_debug')) : [],
      } : null;
      const called = objectId ? await attempt(send(contents, 'Runtime.callFunctionOn', { objectId, functionDeclaration: CALL_FUNCTION_READER, returnByValue: true, silent: true })) : null;
      await send(contents, 'Runtime.releaseObjectGroup', { objectGroup: 'timon-annotate' });
      frameworks[name] = { isolated, mainWorld, resolved: resolved.ok ? true : resolved.error,
        node: describe ? { name: describe.node.nodeName, attributes: describe.node.attributes } : null, passive,
        callFunctionOn: called && (called.ok ? (called.result.exceptionDetails ? { exception: called.result.exceptionDetails.text } : called.result.result.value) : { error: called.error }),
        tell: await tell(contents) };
    }
    {
      const contents = await open('/shapes');
      const shapes = {};
      for (const id of ['vue', 'svelte']) {
        const rect = await rectOf(contents, '#' + id);
        const { object } = await resolveAt(contents, Math.round(rect.x + 5), Math.round(rect.y + 5));
        isolated = null;
        contents.send('timon:spike-annotate-expandos', '#' + id);
        await waitFor('isolated shapes', () => isolated);
        shapes[id] = { isolated, file: id === 'vue'
          ? await read(contents, object.objectId, ['__vueParentComponent', 'type', '__file'])
          : await read(contents, object.objectId, ['__svelte_meta', 'loc', 'file']),
        line: id === 'svelte' ? await read(contents, object.objectId, ['__svelte_meta', 'loc', 'line']) : null };
      }
      await send(contents, 'Runtime.releaseObjectGroup', { objectGroup: 'timon-annotate' });
      frameworks.shapes = { ...shapes, tell: await tell(contents) };
    }
    {
      const contents = await open('/hostile');
      const calls = () => page(contents, 'window.__pageCalls.splice(0)');
      await calls();
      const rect = await rectOf(contents, '#target');
      const { object } = await resolveAt(contents, Math.round(rect.x + 5), Math.round(rect.y + 5));
      const afterResolve = await calls();
      const element = await ownProperties(contents, object.objectId);
      const fiberEntry = element.result.find(p => p.name.startsWith('__reactFiber$'));
      const propsEntry = element.result.find(p => p.name.startsWith('__reactProps$'));
      const afterElement = await calls();
      const fiber = await ownProperties(contents, fiberEntry.value.objectId);
      const afterProxy = await calls();
      const targetEntry = fiber.internal.find(p => p.name === '[[Target]]');
      const target = targetEntry ? await ownProperties(contents, targetEntry.value.objectId) : { result: [] };
      const ownerEntry = target.result.find(p => p.name === '_debugOwner');
      const sourceEntry = target.result.find(p => p.name === '_debugSource');
      const fileName = sourceEntry ? (await ownProperties(contents, sourceEntry.value.objectId)).result.find(p => p.name === 'fileName') : null;
      const afterTarget = await calls();
      const stackEntry = target.result.find(p => p.name === '_debugStack');
      const stackProps = stackEntry ? await ownProperties(contents, stackEntry.value.objectId) : { result: [] };
      const stackProperty = stackProps.result.find(p => p.name === 'stack');
      const afterStack = await calls();
      const called = await attempt(send(contents, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: CALL_FUNCTION_READER, returnByValue: true, silent: true }));
      const afterCall = await calls();
      await send(contents, 'Runtime.releaseObjectGroup', { objectGroup: 'timon-annotate' });
      frameworks.hostile = {
        passive: { afterResolve, afterElement, afterProxy, afterTarget, afterStack,
          propsIsAccessor: !!propsEntry && !('value' in propsEntry), fiberSubtype: fiberEntry.value.subtype,
          proxyOwnProperties: fiber.result.map(p => p.name), proxyInternal: fiber.internal.map(p => p.name),
          ownerIsAccessor: !!ownerEntry && !('value' in ownerEntry), fileName: fileName && fileName.value ? fileName.value.value : null,
          stackDescription: stackEntry ? String(stackEntry.value.description ?? '').slice(0, 200) : null,
          stackProperty: stackProperty ? ('value' in stackProperty ? { value: String(stackProperty.value.value).slice(0, 200) } : { accessor: true }) : null },
        callFunctionOn: { result: called.ok ? (called.result.exceptionDetails ? { exception: called.result.exceptionDetails.text } : called.result.result.value) : { error: called.error }, pageCalls: afterCall },
        tell: await tell(contents),
      };
    }
    report.checks.frameworks = frameworks;

    report.electron = process.versions.electron;
    report.chrome = process.versions.chrome;
    console.log('SPIKE_REPORT ' + JSON.stringify(report));
  } finally {
    await engine.close();
    await new Promise(resolve => server.close(resolve));
  }
  app.exit(0);
})().catch(fail);
`;

type Cell = { col?: number; row?: number; r?: number; g?: number; b?: number };
interface Snapshot { seen: string[]; focus: string; menu: boolean; checked: boolean; details: boolean; path: string; selection: string; contextMenus?: number }
interface Read { steps: string[]; value?: unknown; type?: string; subtype?: string; description?: string; missing?: string; accessor?: string }
interface Isolated { found: boolean; names: string[]; vue: boolean; svelte: boolean }
interface ReactCheck {
  isolated: Isolated; mainWorld: string[]; resolved: true | string; tell: number;
  passive: { hostType: Read; debugSource: { fileName: Read; lineNumber: Read }; debugStack: Read; debugStackProperty: Read; owner: Read; fiberKeys: string[] };
  callFunctionOn: { key: string | null; file: string | null; line: number | null; owner: string | null; stack: string | null };
}
interface Attempt { ok: boolean; error?: string }
interface PageView { scroll: number[]; visual: number[]; inner: number[]; at: string | null }
interface SpikeReport {
  electron: string;
  chrome: string;
  checks: {
    swallow: { on: Record<string, Snapshot>; swallowed: { type: string; target: string; trusted: boolean; prevented: boolean }[]; tabsAfter: number };
    control: { off: Record<string, Snapshot>; swallowed: unknown[] };
    annotateTell: number;
    frameworks: {
      react18: ReactCheck; react19: ReactCheck;
      shapes: { vue: { isolated: Isolated; file: Read }; svelte: { isolated: Isolated; file: Read; line: Read }; tell: number };
      hostile: {
        passive: { afterResolve: string[]; afterElement: string[]; afterProxy: string[]; afterTarget: string[]; afterStack: string[];
          propsIsAccessor: boolean; fiberSubtype: string; proxyOwnProperties: string[]; proxyInternal: string[]; ownerIsAccessor: boolean;
          fileName: string | null; stackProperty: { value?: string; accessor?: boolean } | null };
        callFunctionOn: { result: { file: string | null; stack: string | null }; pageCalls: string[] };
        tell: number;
      };
    };
    clip: {
      loneStatic: string[]; engineScreenshots: ({ width: number; height: number } | string)[];
      engineViewport: { width: number; height: number }; capturePages: string[];
      scroll: { x: number; y: number }; rect: { x: number; y: number };
      cssVisualViewport: { pageX: number; pageY: number };
      capturePage: { viewportRect: { size: { width: number; height: number }; cell: Cell }; documentRect: { size: { width: number; height: number } } };
      clipDocument: string[];
      nodeForLocation: { viewportCoords: string; documentCoords: string };
      boxModel: number[];
      beyondViewport: { before: PageView; after: PageView; resizes: number };
    };
    overlay: {
      base: Cell; withoutEnable: Attempt; withoutEnableCell: Cell; enableWithoutDom: Attempt; domEnable: Attempt; enableWithDom: Attempt;
      withEnable: Attempt; withEnableCell: Cell; hide: Attempt; hiddenCell: Cell;
      page: { nodes: number[]; viewport: number[][] }; events: string[]; tell: number;
    };
    tellControl: number;
  };
}

/** Opt-in because this starts a real Electron process, even though all its windows stay hidden. */
test('annotate spike: swallowed gestures, passive fiber reads, clip coordinates, overlay, framework sources', {
  skip: process.env.TIMON_ELECTRON_SMOKE !== '1', timeout: 100_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'timon-annotate-spike-'));
  const electron = createRequire(import.meta.url)('electron') as string;
  // React copies already installed by two workspaces of this repository: nothing is added to it.
  const react18 = dirname(createRequire(new URL('../../app/package.json', import.meta.url)).resolve('react/package.json'));
  const reactDom18 = dirname(createRequire(new URL('../../app/package.json', import.meta.url)).resolve('react-dom/package.json'));
  const fromDocs = createRequire(new URL('../../public-docs/package.json', import.meta.url));
  const react19 = dirname(fromDocs.resolve('react/package.json'));
  const reactDom19 = dirname(fromDocs.resolve('react-dom/package.json'));
  const scheduler19 = dirname(createRequire(join(reactDom19, 'package.json')).resolve('scheduler/package.json'));
  const files = {
    '/r18/react.js': join(react18, 'umd', 'react.development.js'),
    '/r18/react-dom.js': join(reactDom18, 'umd', 'react-dom.development.js'),
    '/r19/react.js': join(react19, 'cjs', 'react.development.js'),
    '/r19/jsx-dev-runtime.js': join(react19, 'cjs', 'react-jsx-dev-runtime.development.js'),
    '/r19/react-dom.js': join(reactDom19, 'cjs', 'react-dom.development.js'),
    '/r19/react-dom-client.js': join(reactDom19, 'cjs', 'react-dom-client.development.js'),
    '/r19/scheduler.js': join(scheduler19, 'cjs', 'scheduler.development.js'),
  };
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
    await writeFile(join(root, 'native-browser-preload.cjs'), preload + SPIKE_ANNOTATOR);
    new Script(fixture, { filename: 'smoke.cjs' });
    await writeFile(join(root, 'smoke.cjs'), fixture);
    const env = { ...process.env, TIMON_HOME: root, TIMON_SPIKE_FILES: JSON.stringify(files) };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(electron, [join(root, 'smoke.cjs')], {
      env, timeout: 90_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    }).catch((error) => { throw new Error(`Annotate spike failed (${error.code ?? error.signal}): ${error.stdout}\n${error.stderr}`); });
    const line = stdout.split('\n').find((candidate) => candidate.startsWith('SPIKE_REPORT '));
    assert.ok(line, stdout);
    const report = JSON.parse(line.slice('SPIKE_REPORT '.length)) as SpikeReport;
    console.log(JSON.stringify({ electron: report.electron, chrome: report.chrome }));
    const { swallow, control, frameworks, clip, overlay } = report.checks;

    // 1. Swallowing. Control first: the same gestures, preload idle, do reach the page and its defaults.
    for (const step of ['field', 'menu', 'check', 'summary', 'dblclick', 'middle', 'right', 'tap']) {
      assert.ok(control.off[step]!.seen.length > 0, `control: the page sees the ${step} gesture`);
    }
    assert.ok(control.off.right!.seen.includes('window:contextmenu') && control.off.middle!.seen.includes('window:auxclick')
      && control.off.dblclick!.seen.includes('window:dblclick') && control.off.tap!.seen.includes('window:touchstart'));
    assert.equal(control.off.field!.focus, 'field');
    assert.deepEqual([control.off.menu!.menu, control.off.check!.checked, control.off.summary!.details], [true, true, true]);
    assert.equal(control.off.dblclick!.selection, 'wordone');
    assert.equal(control.off.right!.contextMenus, 1);
    for (const [step, snapshot] of Object.entries(swallow.on)) {
      assert.deepEqual(snapshot.seen, [], `annotating: the page's earliest capture listeners see nothing of ${step}`);
      assert.deepEqual([snapshot.focus, snapshot.menu, snapshot.checked, snapshot.details, snapshot.path, snapshot.selection],
        ['BODY', false, false, false, '/annotate', ''], `annotating: no default action for ${step}`);
    }
    assert.equal(swallow.on.right!.contextMenus, 0, 'no native context menu');
    assert.equal(swallow.tabsAfter, 0, 'no tab opened');
    const types = new Set(swallow.swallowed.map(event => event.type));
    for (const type of ['pointerdown', 'pointerup', 'click', 'auxclick', 'dblclick', 'contextmenu', 'touchstart', 'touchend']) {
      assert.ok(types.has(type), `the preload received ${type}`);
    }
    // preventDefault on pointerdown suppresses the compatibility mouse events (and a tap's click):
    // the focus stays put although no mousedown was ever dispatched to cancel.
    assert.ok(!types.has('mousedown') && !types.has('mouseup'), 'no mousedown/mouseup after a prevented pointerdown');
    assert.ok(swallow.swallowed.every(event => event.trusted && event.prevented));
    assert.deepEqual(swallow.swallowed.filter(event => event.type === 'pointerdown').map(event => event.target),
      ['field', 'menu', 'check', 'summary', 'link', 'text', 'text', 'btn', 'btn', 'btn'], 'composedPath()[0] names the picked element');

    // 2 + 5. Expandos and sources, read over CDP with Runtime never enabled.
    for (const name of ['react18', 'react19'] as const) {
      const check = frameworks[name];
      assert.deepEqual(check.isolated, { found: true, names: [], vue: false, svelte: false }, `${name}: the preload's world sees no expando`);
      assert.ok(check.mainWorld.some(key => key.startsWith('__reactFiber$')) && check.mainWorld.some(key => key.startsWith('__reactProps$')));
      assert.equal(check.resolved, true, `${name}: DOM.getNodeForLocation + DOM.resolveNode`);
      assert.equal(check.passive.hostType.value, 'button');
      assert.equal(check.passive.owner.value, 'Card', `${name}: owner component name`);
      assert.equal(check.callFunctionOn.owner, 'Card', `${name}: Runtime.callFunctionOn answers without Runtime.enable`);
    }
    const r18 = frameworks.react18.passive;
    assert.equal(r18.debugSource.fileName.value, '/home/dev/app/src/Card.jsx');
    assert.equal(r18.debugSource.lineNumber.value, 4);
    assert.equal(r18.debugStack.missing, '_debugStack');
    assert.equal(frameworks.react18.callFunctionOn.file, '/home/dev/app/src/Card.jsx');
    const r19 = frameworks.react19.passive;
    assert.equal(r19.debugSource.fileName.missing, '_debugSource', 'React 19 dropped _debugSource');
    assert.equal(r19.debugStack.subtype, 'error');
    // The JSX call site is the second frame, as a served URL: Vite serves /src/… as is, a bundler needs source maps.
    assert.match(String(r19.debugStack.description), /\n\s+at Card \(http:\/\/127\.0\.0\.1:\d+\/src\/App19\.js:4:10\)/);
    assert.equal(r19.debugStackProperty.type, 'string', '`stack` is a data property: no getter to call');
    assert.match(String(frameworks.react19.callFunctionOn.stack), /\/src\/App19\.js:4:10/);
    assert.deepEqual(frameworks.shapes.vue.isolated, { found: true, names: [], vue: false, svelte: false });
    assert.equal(frameworks.shapes.vue.file.value, '/home/dev/app/src/components/Card.vue', 'a non-enumerable expando is listed too');
    assert.equal(frameworks.shapes.svelte.file.value, 'src/lib/Card.svelte');
    assert.equal(frameworks.shapes.svelte.line.value, 3);

    // Passivity, on a page that traps every read.
    const hostile = frameworks.hostile;
    assert.deepEqual([hostile.passive.afterResolve, hostile.passive.afterElement, hostile.passive.afterProxy], [[], [], []],
      'Runtime.getProperties neither calls a getter nor a Proxy trap');
    assert.ok(hostile.passive.propsIsAccessor && hostile.passive.ownerIsAccessor, 'getters are reported as accessors, not called');
    assert.equal(hostile.passive.fiberSubtype, 'proxy');
    assert.deepEqual(hostile.passive.proxyOwnProperties, []);
    assert.deepEqual(hostile.passive.proxyInternal, ['[[Handler]]', '[[Target]]', '[[IsRevoked]]']);
    // Listing an object that holds a never-read Error formats its stack for the description: the
    // page's Error.prepareStackTrace runs, once, and decides what the "stack" says.
    assert.deepEqual(hostile.passive.afterTarget, ['prepareStackTrace']);
    assert.deepEqual(hostile.passive.stackProperty, { value: 'prepared' });
    assert.equal(hostile.passive.fileName, '/home/dev/app/src/Hostile.tsx');
    // The design's callFunctionOn reader runs in the page's realm: patched builtins, traps and getters fire.
    assert.ok(['Object.keys', 'proxy:get', 'getter:_debugOwner'].every(call => hostile.callFunctionOn.pageCalls.includes(call)),
      'Runtime.callFunctionOn is not passive');
    assert.equal(hostile.callFunctionOn.result.stack, 'prepared');

    // 3. Captures on a page scrolled to (149, 1150): the target cell (12, 30) sits at viewport (451, 350).
    assert.deepEqual(clip.scroll, { x: 149, y: 1150 });
    assert.deepEqual([clip.cssVisualViewport.pageX, clip.cssVisualViewport.pageY], [149, 1150], 'pageX/pageY = scroll offset');
    assert.deepEqual(clip.rect, { x: 451, y: 350 });
    // Hidden host window, static page: one Page.captureScreenshot in two never answers. If this
    // flips on an Electron upgrade, re-read PROGRESS (#468, #473).
    assert.ok(clip.loneStatic.includes('timeout') && clip.loneStatic.includes('ok'), `lone captures: ${clip.loneStatic}`);
    // The engine's own 'screenshot' no longer goes through it: every call answers (TODO #473).
    assert.deepEqual(clip.engineScreenshots, Array(4).fill(clip.engineViewport), `engine screenshots: ${JSON.stringify(clip.engineScreenshots)}`);
    assert.deepEqual(clip.capturePages, ['ok', 'ok', 'ok', 'ok'], 'webContents.capturePage always answers');
    assert.deepEqual(clip.capturePage.viewportRect, { size: { width: 50, height: 50 }, cell: { col: 12, row: 30 } },
      'capturePage takes viewport CSS px (deviceScaleFactor 1)');
    assert.deepEqual(clip.capturePage.documentRect.size, { width: 0, height: 0 }, 'a rect outside the viewport is empty');
    assert.ok(!clip.clipDocument.every(answer => answer === '{"col":12,"row":30}'),
      `captureScreenshot's clip is not dependable here: ${clip.clipDocument}`);
    assert.deepEqual(clip.nodeForLocation, { viewportCoords: 'No node found at given location', documentCoords: 'c-12-30' },
      'DOM.getNodeForLocation takes document coordinates');
    assert.deepEqual(clip.boxModel, [451, 350], 'DOM.getBoxModel answers in viewport coordinates');
    assert.ok(clip.beyondViewport.resizes > 0, 'captureBeyondViewport fires resize in the page');
    assert.notDeepEqual(clip.beyondViewport.after.scroll, clip.beyondViewport.before.scroll, 'and moves its scroll position');

    // 4. Overlay.highlightRect.
    assert.deepEqual(overlay.withoutEnable, { ok: false, error: 'Overlay must be enabled before a tool can be shown' });
    assert.deepEqual(overlay.enableWithoutDom, { ok: false, error: 'DOM should be enabled first' });
    assert.ok(overlay.domEnable.ok && overlay.enableWithDom.ok && overlay.withEnable.ok && overlay.hide.ok);
    assert.deepEqual([overlay.base, overlay.withoutEnableCell, overlay.withEnableCell, overlay.hiddenCell],
      [{ col: 0, row: 0 }, { col: 0, row: 0 }, { r: 255, g: 0, b: 0 }, { col: 0, row: 0 }], 'painted after DOM.enable + Overlay.enable, gone after hideHighlight');
    assert.equal(overlay.page.nodes[0], overlay.page.nodes[1], 'no node added to the page');
    assert.deepEqual(overlay.page.viewport[0], overlay.page.viewport[1]);
    assert.deepEqual(overlay.events, []);

    // Runtime was never enabled by any of the above; the control proves the tell is alive.
    assert.deepEqual([report.checks.annotateTell, frameworks.react18.tell, frameworks.react19.tell, frameworks.shapes.tell, hostile.tell, overlay.tell],
      [0, 0, 0, 0, 0, 0], 'no Runtime.enable tell fired');
    assert.ok(report.checks.tellControl > 0, 'the tell fires once Runtime is enabled');
  } finally { await rm(root, { recursive: true, force: true }); }
});
