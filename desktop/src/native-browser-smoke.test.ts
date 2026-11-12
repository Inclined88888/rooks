import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runInNewContext, Script } from 'node:vm';
import ts from 'typescript';

/** Installed synchronously, before app.whenReady() or any dynamic browser import. */
const quietElectronErrors = String.raw`
const reportSmokeFailure = (...errors) => {
  const details = errors.map(error => error?.stack ?? String(error)).join('\n');
  require('node:fs').writeSync(2, '[Electron smoke pid=' + process.pid + ' ' + new Date().toISOString() + ']\n' + details + '\n');
  app.exit(1);
};
// Electron's default uncaught handler can open a blocking native error dialog even
// when every BrowserWindow has show:false. Tests must fail in stderr instead.
dialog.showErrorBox = (title, content) => reportSmokeFailure(title, content);
dialog.showMessageBox = (...args) => { reportSmokeFailure('Unexpected native message box', ...args); return Promise.resolve({response:1,checkboxChecked:false}); };
dialog.showMessageBoxSync = (...args) => { reportSmokeFailure('Unexpected native message box', ...args); return 1; };
process.on('uncaughtException', reportSmokeFailure);
process.on('unhandledRejection', reportSmokeFailure);
`;
const quietElectronBootstrap = `const {app,dialog}=require('electron');\n${quietElectronErrors}\nglobalThis.__rooksSmokeFailure=reportSmokeFailure;\ntry { require('./smoke.cjs'); } catch(error) { reportSmokeFailure(error); }`;

test('the separate smoke bootstrap catches fixture parse errors before Electron sees them', () => {
  new Script(quietElectronBootstrap);
  const exits: number[] = [];
  const stderr: string[] = [];
  const fixtureError = new SyntaxError('fixture syntax failure');
  runInNewContext(quietElectronBootstrap, {
    process: Object.assign(new EventEmitter(), { pid: 123 }),
    require: (name: string) => {
      if (name === 'electron') return { app: { exit: (code: number) => exits.push(code) }, dialog: {} };
      if (name === 'node:fs') return { writeSync: (fd: number, message: string) => { assert.equal(fd, 2); stderr.push(message); } };
      assert.equal(name, './smoke.cjs'); throw fixtureError;
    },
  });
  assert.deepEqual(exits, [1]);
  assert.ok(stderr[0]?.includes(fixtureError.stack!));
});

test('Electron smoke failures write full errors to stderr and exit without native dialogs', () => {
  const process = Object.assign(new EventEmitter(), { pid: 12345 });
  const exits: number[] = [];
  const stderr: string[] = [];
  const dialog = { showErrorBox: (_title: string, _content: string) => assert.fail('Native dialog opened') };
  runInNewContext(quietElectronErrors, {
    app: { exit: (code: number) => exits.push(code) }, process, dialog,
    require: (name: string) => {
      assert.equal(name, 'node:fs');
      return { writeSync: (fd: number, message: string) => { assert.equal(fd, 2); stderr.push(message); } };
    },
  });
  const exception = new Error('uncaught fixture');
  const rejection = new Error('rejected fixture');
  process.emit('uncaughtException', exception);
  process.emit('unhandledRejection', rejection);
  dialog.showErrorBox('JavaScript error', 'Complete error details\nwith stack trace');
  assert.deepEqual(exits, [1, 1, 1]);
  assert.ok(stderr[0]?.includes(exception.stack!));
  assert.ok(stderr[1]?.includes(rejection.stack!));
  assert.ok(stderr[2]?.includes('JavaScript error\nComplete error details\nwith stack trace'));
  for (const message of stderr) assert.match(message, /^\[Electron smoke pid=12345 \d{4}-\d\d-\d\dT[^\]]+\]/);
});

/** Opt-in because this starts a real Electron process, even though all its windows stay hidden. */
test('real hidden Chromium isolates profiles, captures and accepts input after native UI closure', {
  skip: process.env.ROOKS_ELECTRON_SMOKE !== '1', timeout: 45_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'rooks-native-browser-smoke-'));
  const electron = createRequire(import.meta.url)('electron') as string;
  try {
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    for (const name of ['native-browser', 'native-browser-protocol', 'native-browser-credentials', 'native-browser-user-agent', 'native-browser-devtools', 'native-browser-cookies', 'native-browser-chrome', 'native-browser-chrome-signin', 'native-browser-recorder', 'native-browser-annotator']) {
      const source = await readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8');
      const compiled = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText;
      await writeFile(join(root, `${name}.js`), compiled);
    }
    const preloadSource = await readFile(new URL('./native-browser-preload.cts', import.meta.url), 'utf8');
    await writeFile(join(root, 'native-browser-preload.cjs'), ts.transpileModule(preloadSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText);
    await writeFile(join(root, 'smoke.cjs'), `
const { app, BrowserWindow, nativeImage, dialog, ipcMain } = require('electron');
const reportSmokeFailure = globalThis.__rooksSmokeFailure;
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { join } = require('node:path');
const home = process.env.ROOKS_HOME;
app.setPath('userData', join(home, 'shell'));
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  console.log('SMOKE_BOOT', new Date().toISOString(), 'pid=' + process.pid);
  await app.whenReady();
  console.log('SMOKE_READY');
  app.dock?.hide();
  const { NativeBrowserEngine } = await import('./native-browser.js');
  const promptHandlersBefore = ipcMain.listenerCount('rooks:native-browser-prompt');
  const engine = new NativeBrowserEngine(home);
  assert.equal(ipcMain.listenerCount('rooks:native-browser-prompt'), promptHandlersBefore + 1);
  const page = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Browser smoke</title><style>body{margin:0;background:#456789;height:2400px}input{position:absolute;left:20px;top:20px;width:250px;height:40px}</style><input id="field" value=""><button id="popup" style="position:absolute;top:100px;left:20px" onclick="window.open(location.href)">Open</button><input id="upload" type="file" multiple style="top:150px"><button id="prompt" style="position:absolute;top:210px;left:20px" onclick="window.promptAnswer=prompt(&quot;Question&quot;,&quot;default&quot;)">Prompt</button><a id="download" href="/download" download style="position:absolute;top:250px;left:20px">Download</a><input id="range" type="range" min="0" max="100" value="0" style="top:300px">';
  const server = createServer((req, res) => {
    if (req.url === '/download') { res.setHeader('Content-Type','text/plain'); res.setHeader('Content-Disposition','attachment; filename="smoke.txt"'); res.end('downloaded fixture'); return; }
    res.setHeader('Content-Type','text/html'); res.end(page);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  const command = (profileId, action, params = {}) => engine.command({ profileId, action, ...params });
  const evaluate = async (profileId, expression) => (await command(profileId, 'evaluate', { expression })).result;
  const ready = async profileId => {
    for (let i = 0; i < 100; i++) {
      try { if (await evaluate(profileId, '!!document.getElementById("field")')) return; } catch {}
      await delay(50);
    }
    throw new Error('Browser fixture never loaded');
  };
  try {
    console.log('SMOKE_START_A');
    await command('a', 'start');
    console.log('SMOKE_NAVIGATE_A');
    await command('a', 'navigate', { url });
    await ready('a');
    await evaluate('a', 'document.cookie="access=client-a; Max-Age=3600"; localStorage.setItem("secret", "a"); true');
    await command('b', 'start');
    console.log('SMOKE_START_B');
    await command('b', 'navigate', { url });
    await ready('b');
    assert.equal(await evaluate('b', 'document.cookie'), '');
    assert.equal(await evaluate('b', 'localStorage.getItem("secret")'), null);
    const aTab = (await command('a', 'status')).activeTabId;
    await assert.rejects(command('b', 'activateTab', { tabId: aTab }), /does not belong/);
    const fakeWindow = new BrowserWindow({ show: false, useContentSize: true, width: 1400, height: 900 });
    const originalChildren = fakeWindow.contentView.children.length;
    console.log('SMOKE_ATTACH');
    const ticket = await command('a', 'presentation');
    assert.throws(() => engine.attach(fakeWindow, { ...ticket, profileId: 'b', bounds: { x: 0, y: 0, width: 1366, height: 768 } }), /ticket/);
    engine.attach(fakeWindow, { ...ticket, profileId: 'a', bounds: { x: 0, y: 0, width: 1366, height: 768 } });
    assert.equal(fakeWindow.contentView.children.length, originalChildren + 1);
    await command('a', 'revokePresentation');
    assert.equal(fakeWindow.contentView.children.length, originalChildren);
    assert.throws(() => engine.attach(fakeWindow, { ...ticket, profileId: 'a', bounds: { x: 0, y: 0, width: 1366, height: 768 } }), /ticket/);
    const renewed = await command('a', 'presentation');
    engine.attach(fakeWindow, { ...renewed, profileId: 'a', bounds: { x: 0, y: 0, width: 1366, height: 768 } });
    // A presented view of a static page answers every capture too (TODO #473).
    for (let i = 0; i < 2; i++) {
      const presented = await command('a', 'screenshot');
      assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(presented.data, 'base64')).getSize(), { width: 1366, height: 768 });
    }
    fakeWindow.on('close', () => engine.detach());
    fakeWindow.close();
    console.log('SMOKE_INPUT_HIDDEN');
    await evaluate('a', 'window.lastMove=null; document.addEventListener("mousemove",e=>window.lastMove={x:e.clientX,y:e.clientY,buttons:e.buttons})');
    await command('a', 'input', { event: { type: 'move', x: 60, y: 40, buttons: 0, button: 'none' } });
    assert.deepEqual(await evaluate('a', 'window.lastMove'), { x: 60, y: 40, buttons: 0 });
    assert.equal(await evaluate('a', 'document.getElementById("field").matches(":hover")'), true, 'unpressed movement hovers the hidden page');
    await command('a', 'input', { event: { type: 'move', x: 500, y: 400, buttons: 0, button: 'left' } });
    assert.deepEqual(await evaluate('a', 'window.lastMove'), { x: 500, y: 400, buttons: 0 });
    assert.equal(await evaluate('a', 'document.getElementById("field").matches(":hover")'), false);

    assert.equal(engine.hasSessions, true);
    await command('a', 'input', { event: { type: 'click', x: 60, y: 40 } });
    await command('a', 'input', { event: { type: 'text', text: 'Bonjour mobile' } });
    await command('a', 'input', { event: { type: 'key', key: 'Backspace' } });
    assert.equal(await evaluate('a', 'document.getElementById("field").value'), 'Bonjour mobil');
    let screenshot = await command('a', 'screenshot');
    console.log('SMOKE_CAPTURE');
    assert.equal(screenshot.mimeType, 'image/jpeg');
    assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(screenshot.data, 'base64')).getSize(), { width: 1366, height: 768 });
    assert.ok(screenshot.data.length > 1000);
    await command('a', 'resize', { width: 390, height: 844, mobile: true });
    console.log('SMOKE_MOBILE');
    assert.equal(await evaluate('a', 'window.innerWidth'), 390);
    assert.match(await evaluate('a', 'navigator.userAgent'), /Mobile/);
    assert.equal(await evaluate('a', 'document.cookie'), 'access=client-a');
    screenshot = await command('a', 'screenshot');
    assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(screenshot.data, 'base64')).getSize(), { width: 390, height: 844 });
    await command('a', 'newTab', { url });
    assert.equal((await command('a', 'status')).tabs.length, 2);
    await command('a', 'closeTab', { tabId: (await command('a', 'status')).activeTabId });
    assert.equal((await command('a', 'status')).tabs.length, 1);
    await command('a', 'stop');
    await command('a', 'start');
    await ready('a');
    assert.equal(await evaluate('a', 'document.cookie'), 'access=client-a');
    assert.equal(await evaluate('a', 'localStorage.getItem("secret")'), 'a');
    assert.equal(await evaluate('a', 'window.innerWidth'), 390);
    await command('a', 'resize', { width: 1366, height: 768, mobile: false });
    assert.equal(await evaluate('a', 'window.innerWidth'), 1366);
    console.log('SMOKE_INTERACTIONS');
    const ownedContents = engine.mediaSource('a').webContents;
    const subframePrompt = { sender: ownedContents, senderFrame: {}, returnValue: 'unchanged' };
    assert.equal(engine.handlePrompt(subframePrompt, 'forbidden frame', ''), true);
    assert.equal(subframePrompt.returnValue, null);
    const oversizedPrompt = { sender: ownedContents, senderFrame: ownedContents.mainFrame, returnValue: 'unchanged' };
    assert.equal(engine.handlePrompt(oversizedPrompt, 'x'.repeat(32769), ''), true);
    assert.equal(oversizedPrompt.returnValue, null);
    assert.equal((await command('a', 'status')).dialog, null);
    await command('a', 'input', { event: { type: 'click', x: 50, y: 220 } });
    // The prompt reaches the engine over IPC after the click resolves.
    for (let i = 0; i < 50 && !(await command('a', 'status')).dialog; i++) await delay(20);
    const pendingDialog = (await command('a', 'status')).dialog;
    assert.equal(pendingDialog.type, 'prompt');
    assert.equal(pendingDialog.message, 'Question');
    await assert.rejects(command('b', 'dialogRespond', { dialogId: pendingDialog.id, accept: true }), /no longer pending/);
    await command('a', 'dialogRespond', { dialogId: pendingDialog.id, accept: true, promptText: 'Rooks answer' });
    assert.equal(await evaluate('a', 'window.promptAnswer'), 'Rooks answer');
    for (const kind of ['confirm', 'alert']) {
      await evaluate('a', 'setTimeout(()=>{window.dialogAnswer=' + kind + '("Native ' + kind + '")},0);true');
      let pending;
      for (let i = 0; i < 40; i++) { pending = (await command('a', 'status')).dialog; if (pending) break; await delay(50); }
      assert.equal(pending.type, kind);
      await command('a', 'dialogRespond', { dialogId: pending.id, accept: true });
      assert.equal(await evaluate('a', 'window.dialogAnswer'), kind === 'confirm' ? true : null);
      assert.equal((await command('a', 'status')).dialog, null);
    }
    await command('a', 'input', { event: { type: 'click', x: 55, y: 165 } });
    let chooser;
    for (let i = 0; i < 40; i++) { chooser = (await command('a', 'status')).fileChooser; if (chooser) break; await delay(50); }
    assert.ok(chooser && chooser.multiple);
    const payload = Buffer.from('upload fixture');
    await assert.rejects(command('a', 'fileUploadBegin', { chooserId: chooser.id, name: '../escape', size: payload.length }), /file name/);
    const upload = await command('a', 'fileUploadBegin', { chooserId: chooser.id, name: 'input.txt', size: payload.length });
    await assert.rejects(command('b', 'fileUploadChunk', { uploadId: upload.uploadId, offset: 0, data: payload.toString('base64') }), /no longer pending/);
    await command('a', 'fileUploadChunk', { uploadId: upload.uploadId, offset: 0, data: payload.toString('base64') });
    await command('a', 'fileUploadCommit', { chooserId: chooser.id, uploadIds: [upload.uploadId] });
    assert.equal(await evaluate('a', 'document.getElementById("upload").files[0].name'), 'input.txt');
    assert.equal(await evaluate('a', 'document.getElementById("upload").files[0].text()'), 'upload fixture');
    await command('a', 'input', { event: { type: 'click', x: 55, y: 260 } });
    let download;
    for (let i = 0; i < 100; i++) { download = (await command('a', 'status')).downloads[0]; if (download?.state === 'completed') break; await delay(50); }
    assert.equal(download.state, 'completed');
    await assert.rejects(command('b', 'downloadRead', { downloadId: download.id, offset: 0 }), /does not belong/);
    const downloaded = await command('a', 'downloadRead', { downloadId: download.id, offset: 0 });
    assert.equal(Buffer.from(downloaded.data, 'base64').toString(), 'downloaded fixture');
    assert.equal(downloaded.name, 'smoke.txt');
    await evaluate('a', 'const f=document.getElementById("field");f.focus();f.value="clipboard selection";f.setSelectionRange(0,9);true');
    assert.deepEqual(await command('a', 'clipboardRead'), { text: 'clipboard' });
    assert.deepEqual(await command('a', 'clipboardRead', { cut: true }), { text: 'clipboard' });
    assert.equal(await evaluate('a', 'document.getElementById("field").value'), ' selection');
    await command('a', 'clipboardPaste', { text: 'explicit' });
    assert.equal(await evaluate('a', 'document.getElementById("field").value'), 'explicit selection');
    await assert.rejects(command('a', 'input', { event: { type: 'key', key: 'v', modifiers: ['Meta'] } }), /explicit clipboard/);
    assert.equal((await command('a', 'audio', { muted: false })).audioMuted, false);
    assert.equal(engine.mediaSource('a').webContents.isAudioMuted(), false);
    assert.equal((await command('a', 'revokePresentation')).audioMuted, true);
    assert.equal(engine.mediaSource('a').webContents.isAudioMuted(), true, 'control takeover silences the previous native viewer');
    await command('a', 'input', { event: { type: 'down', x: 28, y: 320, buttons: 1 } });
    await command('a', 'input', { event: { type: 'move', x: 240, y: 320, buttons: 1 } });
    await command('a', 'input', { event: { type: 'up', x: 240, y: 320 } });
    assert.ok(Number(await evaluate('a', 'document.getElementById("range").value')) > 50, 'pointer drag changes slider');
    await command('a', 'input', { event: { type: 'click', x: 55, y: 40, button: 'right' } });
    assert.ok((await command('a', 'status')).contextMenu);
    await command('a', 'contextMenuDismiss');
    await evaluate('a', 'navigator.geolocation.getCurrentPosition(()=>window.geo="allowed",()=>window.geo="denied");true');
    let permission;
    for (let i = 0; i < 50; i++) { permission=(await command('a', 'status')).permissions[0]; if (permission) break; await delay(50); }
    assert.equal(permission.permission, 'geolocation');
    await command('a', 'permissionRespond', { permissionId: permission.id, allow: false });
    for (let i = 0; i < 50 && await evaluate('a', 'window.geo') !== 'denied'; i++) await delay(50);
    assert.equal(await evaluate('a', 'window.geo'), 'denied');
    // Test grants without requesting actual camera/microphone access from macOS.
    let microphoneAllowed;
    engine.requestPermission('a', engine.mediaSource('a').webContents, 'media', value => { microphoneAllowed = value; }, { requestingUrl: url, mediaTypes: ['audio'] });
    permission = (await command('a', 'status')).permissions[0];
    assert.deepEqual(permission.mediaTypes, ['audio']);
    await command('a', 'permissionRespond', { permissionId: permission.id, allow: true });
    assert.equal(microphoneAllowed, true);
    let cameraAllowed;
    engine.requestPermission('a', engine.mediaSource('a').webContents, 'media', value => { cameraAllowed = value; }, { requestingUrl: url, mediaTypes: ['video'] });
    assert.equal(cameraAllowed, undefined, 'a microphone grant does not automatically authorize the camera');
    permission = (await command('a', 'status')).permissions[0];
    assert.deepEqual(permission.mediaTypes, ['video']);
    await command('a', 'permissionRespond', { permissionId: permission.id, allow: false });
    assert.equal(cameraAllowed, false);
    console.log('SMOKE_POPUP');
    await command('a', 'input', { event: { type: 'click', x: 45, y: 110 } });
    console.log('SMOKE_POPUP_CLICKED');
    for (let i = 0; i < 50 && (await command('a', 'status')).tabs.length !== 2; i++) await delay(50);
    assert.equal((await command('a', 'status')).tabs.length, 2, 'site popups stay inside the same profile');
    await ready('a');
    console.log('SMOKE_POPUP_READY');
    assert.equal(await evaluate('a', '!!window.opener'), true, 'OAuth popup keeps its opener relationship');
    assert.equal(await evaluate('a', 'document.cookie'), 'access=client-a');
    await command('a', 'input', { event: { type: 'wheel', x: 300, y: 300, deltaY: 400 } });
    console.log('SMOKE_WHEEL');
    for (let i = 0; i < 20 && await evaluate('a', 'scrollY') === 0; i++) await delay(50);
    assert.ok(await evaluate('a', 'scrollY') > 0, 'remote wheel scrolls the hidden page');
    console.log('SMOKE_DEVTOOLS');
    await command('b', 'navigate', { url });
    await ready('b');
    // Runtime.enable replays what Chromium already holds for the document: only new messages are asserted.
    const replayed = (await command('b', 'consoleList')).messages;
    await evaluate('b', 'console.warn("smoke warning", {n: 1}); setTimeout(() => { throw new Error("smoke boom") }, 0); fetch("/download", {headers: {Authorization: "Bearer smoke-secret"}}).then(r => r.text())');
    await delay(300);
    const consoleMessages = (await command('b', 'consoleList')).messages.slice(replayed.length);
    assert.deepEqual(consoleMessages.map(m => m.type), ['warning', 'error']);
    assert.equal(consoleMessages[0].text, 'smoke warning {n: 1}');
    assert.match(consoleMessages[1].text, /^Error: smoke boom/);
    assert.match((await command('b', 'consoleGet', { msgid: consoleMessages[1].msgid })).stack.join(''), /smoke|anonymous/);
    const requests = (await command('b', 'networkList', { resourceTypes: ['fetch'] })).requests;
    assert.equal(requests.length, 1);
    const detail = await command('b', 'networkGet', { reqid: requests[0].reqid });
    assert.equal(detail.status, 200);
    assert.equal(detail.responseBody, 'downloaded fixture');
    assert.equal(detail.requestHeaders.Authorization, '<redacted>');
    await command('b', 'emulate', { networkConditions: 'Offline' });
    assert.equal(await evaluate('b', 'fetch("/download").then(() => "online", () => "offline")'), 'offline');
    await command('b', 'emulate', { networkConditions: 'No emulation', cpuThrottlingRate: 1 });
    const trace = await command('b', 'performanceStart', { reload: true, autoStop: true });
    assert.ok(trace.page.navigation && trace.page.url === url, 'performance summary describes the reloaded page');
    assert.equal(typeof trace.metrics.scriptDurationMs, 'number');
    assert.ok((await command('b', 'consoleList')).messages.every(m => !m.text.includes('smoke')), 'a reload starts a fresh console history');
    await assert.rejects(evaluate('b', 'new Promise(() => {})'), /timed out/);
    assert.equal(await evaluate('b', '2 + 2'), 4, 'unresolved page promises cannot block later commands or shutdown');
    console.log('NATIVE_BROWSER_SMOKE_OK');
  } finally {
    await engine.close();
    assert.equal(ipcMain.listenerCount('rooks:native-browser-prompt'), promptHandlersBefore);
    await new Promise(resolve => server.close(resolve));
  }
  app.exit(0);
})().catch(reportSmokeFailure);
`);
    const bootstrap = quietElectronBootstrap;
    // Validate generated source before spawning Electron. A bootstrap in its own
    // module also catches parse errors in the fixture before Electron's loader can
    // show its native "App threw an error during load" dialog.
    new Script(bootstrap, { filename: 'bootstrap.cjs' });
    new Script(await readFile(join(root, 'smoke.cjs'), 'utf8'), { filename: 'smoke.cjs' });
    await writeFile(join(root, 'bootstrap.cjs'), bootstrap);
    const env = { ...process.env, ROOKS_HOME: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(electron, [join(root, 'bootstrap.cjs')], { env, timeout: 30_000, killSignal: 'SIGKILL' })
      .catch((error) => { throw new Error(`Electron smoke failed (${error.code ?? error.signal}): ${error.stdout}\n${error.stderr}`); });
    assert.match(stdout, /NATIVE_BROWSER_SMOKE_OK/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
