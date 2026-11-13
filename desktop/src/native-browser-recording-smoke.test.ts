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
 * The recorder end to end under the pinned Electron (TODO #461): the real preload and the real
 * engine, human input through `webContents.sendInputEvent` (the OS input path, no debugger).
 */

const MODULES = ['native-browser', 'native-browser-protocol', 'native-browser-credentials', 'native-browser-user-agent',
  'native-browser-devtools', 'native-browser-cookies', 'native-browser-chrome', 'native-browser-chrome-signin',
  'native-browser-recorder', 'native-browser-annotator'];

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
const page = (title) => '<!doctype html><title>' + title + '</title><style>body{margin:0}button,input{position:absolute;left:20px;width:200px;height:30px}#btn{top:20px}#user{top:70px}#pw{top:120px}#otp{top:170px}#popup{top:220px}</style>'
  + '<button id="btn">Continue</button><label>User <input id="user" name="user"></label><input id="pw" name="pw" type="password">'
  + '<input id="otp" name="otp" autocomplete="username one-time-code"><button id="popup" onclick="window.open(&quot;/popup&quot;)">Open</button>';
(async () => {
  await app.whenReady();
  app.dock?.hide();
  const { NativeBrowserEngine } = await import('./native-browser.js');
  const engine = new NativeBrowserEngine(home);
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(page(req.url)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const command = (action, params = {}) => engine.command({ profileId: 'rec', action, ...params });
  const human = { commandActor: 'human' };
  const profile = () => engine.profiles.get('rec');
  const tabAt = (url) => [...profile().tabs.values()].find(tab => tab.view.webContents.getURL() === url);
  const waitFor = async (what, predicate) => {
    for (let i = 0; i < 200; i++) { const found = await predicate(); if (found) return found; await delay(25); }
    throw new Error('Timed out waiting for ' + what);
  };
  // A fresh document drops input until its first frame is presented.
  const ready = async (url) => {
    const tab = await waitFor(url, () => tabAt(url));
    await waitFor('load ' + url, async () => !tab.view.webContents.isLoading());
    await tab.view.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    return tab.view.webContents;
  };
  const click = async (contents, x, y) => {
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await delay(60);
  };
  const type = async (contents, text) => {
    for (const keyCode of text) {
      contents.sendInputEvent({ type: 'keyDown', keyCode });
      contents.sendInputEvent({ type: 'char', keyCode });
      contents.sendInputEvent({ type: 'keyUp', keyCode });
    }
    await delay(60);
  };
  const steps = async () => (await command('recordStatus')).recording.steps;
  const report = {};
  try {
    await command('start');
    const firstUrl = origin + '/first?token=launch-token';
    await command('navigate', { url: firstUrl });
    const first = await ready(firstUrl);
    report.refusedStart = await command('recordStart').then(() => 'started', error => error.statusCode);
    await command('recordStart', human);
    await click(first, 60, 35);
    await click(first, 60, 85);
    await type(first, 'alice');
    await click(first, 60, 135);
    await type(first, 'hunter2');
    await click(first, 60, 185);
    await type(first, '987654');
    await click(first, 60, 35);
    await waitFor('form steps', async () => await steps() >= 9);
    // The page clicks and dispatches by itself: untrusted, never recorded.
    const before = await steps();
    await command('evaluate', { ...human, expression: 'document.getElementById("btn").click(); document.getElementById("user").dispatchEvent(new Event("change", { bubbles: true })); true' });
    await delay(150);
    report.syntheticRecorded = (await steps()) - before;
    report.agentInput = await command('input', { event: { type: 'click', x: 60, y: 35 } }).then(() => 'accepted', error => error.statusCode);
    const nextUrl = origin + '/next?code=oauth-code-123&page=2#access_token=fragment-token';
    await command('navigate', { ...human, url: nextUrl });
    const next = await ready(nextUrl);
    await click(next, 60, 235);
    const popup = await ready(origin + '/popup');
    await click(popup, 60, 35);
    await waitFor('popup click', async () => await steps() >= 14);
    await delay(200);
    const result = (await command('recordStop', human)).recording;
    report.result = result;
    await click(popup, 60, 35);
    report.afterStop = (await command('recordStatus')).recording;
    console.log('RECORDING_REPORT ' + JSON.stringify(report));
  } finally {
    await engine.close();
    await new Promise(resolve => server.close(resolve));
  }
  app.exit(0);
})().catch(fail);
`;

/** Opt-in because this starts a real Electron process, even though all its windows stay hidden. */
test('recording smoke: the real preload and engine record human steps, mask secrets, ignore page and agent', {
  skip: process.env.ROOKS_ELECTRON_SMOKE !== '1', timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'rooks-recording-smoke-'));
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
      env, timeout: 50_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
    }).catch((error) => { throw new Error(`Recording smoke failed (${error.code ?? error.signal}): ${error.stdout}\n${error.stderr}`); });
    const line = stdout.split('\n').find((candidate) => candidate.startsWith('RECORDING_REPORT '));
    assert.ok(line, stdout);
    const report = JSON.parse(line.slice('RECORDING_REPORT '.length));
    const { steps } = report.result;
    const raw = JSON.stringify(report.result);
    console.log(JSON.stringify(steps, null, 2));

    assert.equal(report.refusedStart, 403);
    assert.equal(report.syntheticRecorded, 0, 'events the page dispatches are not recorded');
    assert.equal(report.agentInput, 409, 'the agent cannot drive a recording browser');
    for (const secret of ['hunter2', '987654', 'launch-token', 'oauth-code-123', 'fragment-token']) {
      assert.ok(!raw.includes(secret), `${secret} leaked: ${raw}`);
    }
    const [firstTab] = [steps[0].tabId];
    assert.deepEqual(steps.slice(0, 9).map((step: Record<string, unknown>) => [step.type, step.value ?? step.text ?? step.url ?? '']), [
      ['navigate', `${new URL(steps[0].url).origin}/first?token={SECRET:token}`],
      ['click', 'Continue'],
      ['click', ''],
      ['input', 'alice'],
      ['click', ''],
      ['secret', '{SECRET:pw}'],
      ['click', ''],
      ['secret', '{SECRET:otp}'],
      ['click', 'Continue'],
    ]);
    assert.equal(steps[2].name, 'User', 'the label names the field');
    assert.equal(steps[7].secret, 'otp');
    assert.ok(steps.slice(0, 9).every((step: { tabId: string }) => step.tabId === firstTab));
    const rest = steps.slice(9).map((step: Record<string, unknown>) => step.type);
    // The popup's activation waits for the profile queue, so it may land either side of its first navigation.
    assert.deepEqual([...rest.slice(0, 3), ...rest.slice(3, 5).sort(), rest[5]],
      ['navigate', 'click', 'newTab', 'navigate', 'switchTab', 'click'], JSON.stringify(steps.slice(9)));
    const byType = (type: string) => steps.slice(9).filter((step: { type: string }) => step.type === type);
    const [navigate, popupNavigate] = byType('navigate');
    const [newTab] = byType('newTab');
    assert.match(navigate.url, /\/next\?code=\{SECRET:code\}&page=2#\{SECRET:fragment\}$/);
    assert.equal(byType('click')[0].text, 'Open');
    assert.equal(newTab.openerTabId, firstTab);
    assert.equal(byType('switchTab')[0].tabId, newTab.tabId);
    assert.equal(popupNavigate.tabId, newTab.tabId);
    assert.ok(popupNavigate.url.endsWith('/popup'));
    assert.equal(steps.at(-1).tabId, newTab.tabId, 'the click in the popup belongs to the popup tab');
    assert.deepEqual(report.afterStop, { active: false, steps: 0 }, 'a stopped recorder buffers nothing');
  } finally { await rm(root, { recursive: true, force: true }); }
});
