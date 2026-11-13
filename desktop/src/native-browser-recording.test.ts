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

const nodeRequire = createRequire(import.meta.url);
const source = (await readFile(new URL('./native-browser.ts', import.meta.url), 'utf8'))
  .replaceAll('import.meta.url', JSON.stringify(new URL('./native-browser.ts', import.meta.url).href));
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const { BROWSER_RECORD_EVENT_CHANNEL: EVENT, BROWSER_RECORD_STATE_CHANNEL: STATE, BROWSER_RECORD_TOGGLE_CHANNEL: TOGGLE } = protocol;
const human = { commandActor: 'human' };

interface FakeContents {
  url: string; sent: unknown[][]; mainFrame: object; destroyed: boolean;
  getURL(): string; getTitle(): string; isDestroyed(): boolean; send(channel: string, value: unknown): void; close(): void;
  capturePage(): Promise<object>;
  navigationHistory: { canGoBack(): boolean; canGoForward(): boolean };
}

function contentsAt(url: string): FakeContents {
  const contents: FakeContents = {
    url, sent: [], mainFrame: {}, destroyed: false,
    getURL: () => contents.url, getTitle: () => '', isDestroyed: () => contents.destroyed,
    send: (channel, value) => { contents.sent.push([channel, value]); }, close: () => { contents.destroyed = true; },
    capturePage: async () => ({ isEmpty: () => false, getSize: () => ({ width: 640, height: 480 }), toJPEG: () => Buffer.from('frame') }),
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  };
  return contents;
}

function fixture() {
  const exports: Record<string, any> = {};
  const ipcMain = new EventEmitter();
  runInNewContext(compiled, {
    exports, console, Buffer, URL, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    require: (name: string) => name === 'electron' ? { ipcMain }
      : name === './native-browser-protocol.js' ? protocol
        : name === './native-browser-credentials.js' ? credentials
          : name === './native-browser-recorder.js' ? recorder : nodeRequire(name),
  });
  const engine = new exports.NativeBrowserEngine('/unused');
  const tabs = {
    a: { id: 'tab-a', view: { webContents: contentsAt('https://app.test/login?code=4/0secret&lang=fr') } },
    b: { id: 'tab-b', view: { webContents: contentsAt('https://app.test/b') } },
  };
  const profile = { id: 'profile-a', dialogs: new Map(), tabs: new Map(Object.values(tabs).map((tab) => [tab.id, tab])),
    activeTabId: 'tab-a', viewport: { width: 640, height: 480, mobile: false }, fileChooser: null, permissions: new Map(),
    downloads: new Map(), contextMenu: null, audioMuted: true, stopping: false, recording: null, recordingTimer: null,
    annotation: null, annotationTimer: null, annotationPicks: [], annotationCapturing: 0, annotationWork: Promise.resolve(), annotationWaiters: new Map() };
  engine.profiles.set(profile.id, profile);
  const cdpCalls: string[] = [];
  engine.cdp = async (_tab: unknown, method: string) => {
    cdpCalls.push(method);
    return method === 'Runtime.evaluate' ? { result: { value: { filled: true } } } : {};
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
  const close = async () => { engine.queues.clear(); engine.profiles.clear(); await engine.close(); };
  return { engine, profile, tabs, ipcMain, command, ipc, cdpCalls, close };
}

const refused = (status: number) => (error: unknown) => error instanceof protocol.BrowserCommandError && error.statusCode === status;

test('only the user starts or stops a recording', { timeout: 2000 }, async () => {
  const { command, profile, close } = fixture();
  try {
    await assert.rejects(command('recordStart'), refused(403));
    await assert.rejects(command('recordStart', { commandActor: 'agent' }), refused(403));
    assert.equal(profile.recording, null);
    await command('recordStart', human);
    await assert.rejects(command('recordStop'), refused(403));
    assert.equal((await command('recordStatus')).recording.active, true, 'anyone may read the state');
  } finally { await close(); }
});

test('starting turns every tab preload on and opens with the masked start page', { timeout: 2000 }, async () => {
  const { command, tabs, close } = fixture();
  try {
    const status = await command('recordStart', human);
    assert.deepEqual(status.recording, { active: true, steps: 1 });
    for (const tab of Object.values(tabs)) assert.deepEqual(tab.view.webContents.sent, [[TOGGLE, true]]);
    await assert.rejects(command('recordStart', human), refused(409));
    const result = (await command('recordStop', human)).recording;
    assert.equal(result.url, 'https://app.test/login?code={SECRET:code}&lang=fr');
    assert.deepEqual(result.steps, [{ t: 0, type: 'navigate', tabId: 'tab-a', url: 'https://app.test/login?code={SECRET:code}&lang=fr' }]);
    assert.ok(!JSON.stringify(result).includes('4/0secret'));
    for (const tab of Object.values(tabs)) assert.deepEqual(tab.view.webContents.sent.at(-1), [TOGGLE, false]);
    await assert.rejects(command('recordStop', human), refused(409));
  } finally { await close(); }
});

test('while recording, the agent cannot move the page; the user can, and reads stay open', { timeout: 2000 }, async () => {
  const { command, cdpCalls, close } = fixture();
  try {
    await command('recordStart', human);
    for (const [action, body] of [['navigate', { url: 'https://x.test/' }], ['input', { event: { type: 'key', key: 'Enter' } }],
      ['evaluate', { expression: '1' }], ['clipboardPaste', { text: 'x' }], ['newTab', {}], ['closeTab', { tabId: 'tab-b' }],
      ['activateTab', { tabId: 'tab-b' }], ['dialogRespond', { dialogId: 'x', accept: true }], ['stop', {}],
      ['fillCredential', { origin: 'https://app.test', username: 'a', password: 'b' }], ['captureCredential', {}],
      ['reload', {}], ['resize', { width: 800, height: 600, mobile: false }]] as const) {
      await assert.rejects(command(action, body), refused(409), action);
      await assert.rejects(command(action, { ...body, commandActor: 'agent' }), refused(409), action);
    }
    assert.deepEqual(cdpCalls, [], 'nothing reached the page');
    assert.equal((await command('status')).recording.active, true);
    assert.equal((await command('screenshot')).data, Buffer.from('frame').toString('base64'));
    await command('navigate', { url: 'https://x.test/', ...human });
    assert.deepEqual(cdpCalls, ['Page.navigate']);
    await command('recordStop', human);
    await command('navigate', { url: 'https://x.test/next' });
    assert.equal(cdpCalls.at(-1), 'Page.navigate', 'the agent resumes once the recording stops');
  } finally { await close(); }
});

test('a command queued before the recording started is refused when it runs', { timeout: 2000 }, async () => {
  const { engine, profile, command, cdpCalls, close } = fixture();
  let release!: () => void;
  engine.queues.set(profile.id, new Promise<void>((resolve) => { release = resolve; }));
  try {
    const queued = command('navigate', { url: 'https://x.test/' });
    // The daemon queues recordStart behind its own work too: here the session simply appears meanwhile.
    (profile as { recording: unknown }).recording = new recorder.RecordingSession('');
    release();
    await assert.rejects(queued, refused(409));
    assert.deepEqual(cdpCalls, []);
  } finally { await close(); }
});

test('recordStop is immediate: it does not wait behind a stuck gesture', { timeout: 2000 }, async () => {
  const { engine, profile, command, close } = fixture();
  try {
    await command('recordStart', human);
    engine.queues.set(profile.id, new Promise(() => {}));
    assert.equal((await command('recordStop', human)).recording.stoppedReason, 'user');
  } finally { await close(); }
});

test('the preload is told to record only for a recording profile tab main frame', { timeout: 2000 }, async () => {
  const { command, ipc, tabs, close } = fixture();
  const stranger = contentsAt('https://evil.test/');
  try {
    assert.equal(ipc(STATE, tabs.a.view.webContents).returnValue, false);
    assert.equal(ipc(STATE, stranger).returnValue, false, 'an unknown sender still gets an answer, never true');
    await command('recordStart', human);
    assert.equal(ipc(STATE, tabs.b.view.webContents).returnValue, true);
    assert.equal(ipc(STATE, tabs.b.view.webContents, undefined, {}).returnValue, false, 'a sub-frame is never told to record');
    assert.equal(ipc(STATE, stranger).returnValue, false);
  } finally { await close(); }
});

test('page events from a refused sender are dropped', { timeout: 2000 }, async () => {
  const { command, ipc, tabs, profile, close } = fixture();
  const click = { type: 'click', tag: 'button', selector: '#go', text: 'Go' };
  const stranger = contentsAt('https://evil.test/');
  try {
    ipc(EVENT, tabs.a.view.webContents, click);
    await command('recordStart', human);
    ipc(EVENT, stranger, click);
    ipc(EVENT, tabs.a.view.webContents, click, {});
    ipc(EVENT, tabs.a.view.webContents, { ...click, text: 'x'.repeat(recorder.RECORDING_EVENT_MAX_BYTES) });
    ipc(EVENT, tabs.a.view.webContents, 'click');
    ipc(EVENT, tabs.a.view.webContents, { type: 'scroll' });
    profile.stopping = true;
    ipc(EVENT, tabs.a.view.webContents, click);
    profile.stopping = false;
    assert.equal((await command('recordStatus')).recording.steps, 1, 'only the start page');
    ipc(EVENT, tabs.b.view.webContents, click);
    const { steps } = (await command('recordStop', human)).recording;
    assert.deepEqual(steps.map((step: recorder.RecordingStep) => [step.type, step.tabId]), [['navigate', 'tab-a'], ['click', 'tab-b']]);
  } finally { await close(); }
});

test('a page flooding the channel is rate limited', { timeout: 2000 }, async () => {
  const { command, ipc, tabs, close } = fixture();
  try {
    await command('recordStart', human);
    for (let index = 0; index < 100; index++) ipc(EVENT, tabs.a.view.webContents, { type: 'click', tag: 'button', text: `n${index}` });
    assert.equal((await command('recordStatus')).recording.steps, 1 + recorder.RECORDING_MAX_PAGE_EVENTS_PER_SECOND);
  } finally { await close(); }
});

test('secrets from the page are masked again on the host', { timeout: 2000 }, async () => {
  const { command, ipc, tabs, close } = fixture();
  try {
    await command('recordStart', human);
    ipc(EVENT, tabs.a.view.webContents, { type: 'input', tag: 'input', inputType: 'password', field: 'pw', value: 'hunter2' });
    ipc(EVENT, tabs.a.view.webContents, { type: 'input', tag: 'input', inputType: 'text', autocomplete: 'username one-time-code', field: 'otp', value: '123456' });
    ipc(EVENT, tabs.a.view.webContents, { type: 'input', tag: 'input', inputType: 'search', field: 'q', value: 'sk-proj-abcdefghijklmnopqrstuvwx' });
    const { steps } = (await command('recordStop', human)).recording;
    assert.deepEqual(steps.slice(1).map((step: recorder.RecordingStep) => [step.type, step.value, step.secret ?? step.flagged]),
      [['secret', '{SECRET:pw}', 'password'], ['secret', '{SECRET:otp}', 'otp'], ['input', 'sk-proj-abcdefghijklmnopqrstuvwx', 'api-key']]);
    assert.ok(!JSON.stringify(steps).includes('hunter2') && !JSON.stringify(steps).includes('123456'));
  } finally { await close(); }
});

test('tab switches, closes and the user\'s credential fills become steps; the agent\'s fills never', { timeout: 2000 }, async () => {
  const { command, close } = fixture();
  try {
    await command('recordStart', human);
    await command('activateTab', { tabId: 'tab-b', ...human });
    await command('fillCredential', { origin: 'https://app.test', username: 'alice', password: 'hunter2', credentialId: 'cred_1', ...human });
    await command('closeTab', { tabId: 'tab-a', ...human });
    const { steps } = (await command('recordStop', human)).recording;
    assert.deepEqual(steps.map(({ t: _t, ...step }: recorder.RecordingStep) => step).slice(1), [
      { type: 'switchTab', tabId: 'tab-b' },
      { type: 'credential', tabId: 'tab-b', origin: 'https://app.test', credentialId: 'cred_1' },
      { type: 'closeTab', tabId: 'tab-a' },
    ]);
    assert.ok(!JSON.stringify(steps).includes('hunter2') && !JSON.stringify(steps).includes('alice'));
    await command('fillCredential', { origin: 'https://app.test', username: 'alice', password: 'hunter2', credentialId: 'cred_2' });
    assert.equal((await command('recordStatus')).recording.steps, 0, 'not recording: nothing is buffered');
  } finally { await close(); }
});

test('stopping the profile hands the recording back with the stop result', { timeout: 2000 }, async () => {
  const { engine, command, close } = fixture();
  engine.stopProfile = async function stopProfile(this: any, profileId: string) {
    // The real teardown needs Electron; keep only the recording part under test.
    const profile = this.profiles.get(profileId);
    const recording = profile.recording;
    recording?.stop('profile-stopped');
    profile.recording = null;
    this.profiles.delete(profileId);
    return recording?.result() ?? null;
  };
  try {
    await command('recordStart', human);
    const stopped = await command('stop', human);
    assert.equal(stopped.running, false);
    assert.equal(stopped.recordingResult.stoppedReason, 'profile-stopped');
    assert.equal(stopped.recordingResult.steps.length, 1);
  } finally { await close(); }
});

test('an agent stopping the browser after an automatic stop gets none of the recorded steps', { timeout: 2000 }, async () => {
  const { engine, profile, command, close } = fixture();
  engine.stopProfile = async function stopProfile(this: any, profileId: string) {
    const current = this.profiles.get(profileId);
    const recording = current.recording;
    current.recording = null;
    this.profiles.delete(profileId);
    return recording?.result() ?? null;
  };
  try {
    await command('recordStart', human);
    // Idle or step limit: the session is over, the agent is no longer excluded.
    (profile.recording as unknown as { stop(reason: string): void }).stop('idle');
    for (const body of [{}, { commandActor: 'agent' }, { commandActor: 'Human' }]) {
      assert.equal((await command('recordStatus', body)).recording.active, false);
    }
    const stopped = await command('stop', { commandActor: 'agent' });
    assert.equal(stopped.running, false);
    assert.equal(stopped.recordingResult, undefined);
    assert.equal(JSON.stringify(stopped).includes('code='), false);
  } finally { await close(); }
});

test('the real stopProfile ends the recording it holds', async () => {
  // Read the source rather than run Electron's teardown: the result must come from the profile's session.
  const body = source.slice(source.indexOf('private async stopProfile('), source.indexOf('async close()'));
  assert.match(body, /recording\?\.stop\('profile-stopped'\)/);
  assert.match(body, /return recording\?\.result\(\) \?\? null;/);
  assert.match(body, /clearTimeout\(profile\.recordingTimer\)/);
});

test('thirty idle minutes stop the recording; the steps wait to be collected', { timeout: 2000 }, async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_753_500_000_000 });
  const { command, ipc, tabs, close } = fixture();
  try {
    await command('recordStart', human);
    mock.timers.tick(recorder.RECORDING_IDLE_MS - 1);
    assert.equal((await command('recordStatus')).recording.active, true);
    // A step pushes the deadline: the timer re-reads the last activity when it fires.
    ipc(EVENT, tabs.a.view.webContents, { type: 'click', tag: 'button', text: 'Go' });
    mock.timers.tick(1);
    assert.equal((await command('recordStatus')).recording.active, true);
    mock.timers.tick(recorder.RECORDING_IDLE_MS - 2);
    assert.equal((await command('recordStatus')).recording.active, true);
    mock.timers.tick(1);
    assert.deepEqual((await command('recordStatus')).recording, { active: false, steps: 2, stoppedReason: 'idle' });
    assert.deepEqual(tabs.a.view.webContents.sent.at(-1), [TOGGLE, false]);
    await assert.rejects(command('recordStart', human), refused(409), 'a finished recording is collected first');
    await command('navigate', { url: 'https://x.test/' });
    const result = (await command('recordStop', human)).recording;
    assert.deepEqual([result.stoppedReason, result.steps.length], ['idle', 2]);
    await command('recordStart', human);
  } finally { await close(); mock.timers.reset(); }
});

test('status exposes the recording state', { timeout: 2000 }, async () => {
  const { command, close } = fixture();
  try {
    assert.deepEqual((await command('status')).recording, { active: false, steps: 0 });
    assert.deepEqual((await command('recordStatus', { profileId: 'not-running' })).recording, { active: false, steps: 0 });
  } finally { await close(); }
});
