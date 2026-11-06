import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkVerdict, installWindowPermissions, isWindowOrigin, microphoneAccess, requestVerdict,
  type MicrophoneAccess, type PermissionAsker, type PermissionSession, type SystemMediaAccess,
} from './window-permissions.js';

const ORIGIN = 'http://127.0.0.1:3110';
const timon: PermissionAsker = { isWindow: true, isMainFrame: true, origin: `${ORIGIN}/chat`, windowOrigin: ORIGIN };

test('a foreign origin is refused the microphone and everything else', () => {
  for (const origin of [
    'https://evil.example/',
    // Another loopback server: an app an agent runs, a dev server.
    'http://127.0.0.1:5173/',
    'http://127.0.0.1:3010/',
    // Same machine, other spelling: not the window's origin.
    'http://localhost:3110/',
    'https://127.0.0.1:3110/',
    'data:text/html,<p>hi</p>',
    'about:blank',
    'null',
    '',
    undefined,
  ]) {
    const asker = { ...timon, origin };
    assert.equal(requestVerdict(asker, 'media', ['audio']), 'deny', `media for ${origin}`);
    assert.equal(requestVerdict(asker, 'clipboard-read', undefined), 'deny', `clipboard for ${origin}`);
    assert.equal(checkVerdict(asker, 'media', 'audio'), false, `check for ${origin}`);
    assert.equal(checkVerdict(asker, 'notifications', undefined), false, `notifications check for ${origin}`);
  }
});

test('the Timon window gets the microphone, never the camera', () => {
  assert.equal(requestVerdict(timon, 'media', ['audio']), 'microphone');
  assert.equal(requestVerdict(timon, 'media', ['video']), 'deny');
  assert.equal(requestVerdict(timon, 'media', ['audio', 'video']), 'deny');
  assert.equal(requestVerdict(timon, 'media', []), 'deny');
  assert.equal(requestVerdict(timon, 'media', undefined), 'deny');
  assert.equal(checkVerdict(timon, 'media', 'audio'), true);
  assert.equal(checkVerdict(timon, 'media', 'video'), false);
  assert.equal(checkVerdict(timon, 'media', 'unknown'), false);
  assert.equal(checkVerdict(timon, 'media', undefined), false);
});

test('a sub-frame, another window or a window not yet on its origin gets nothing', () => {
  for (const asker of [
    { ...timon, isMainFrame: false },
    { ...timon, isWindow: false },
    { ...timon, windowOrigin: '' },
  ]) {
    assert.equal(requestVerdict(asker, 'media', ['audio']), 'deny');
    assert.equal(requestVerdict(asker, 'clipboard-sanitized-write', undefined), 'deny');
    assert.equal(checkVerdict(asker, 'media', 'audio'), false);
  }
});

test('the client keeps what it used before the handlers existed, and nothing more', () => {
  for (const permission of ['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen']) {
    assert.equal(requestVerdict(timon, permission, undefined), 'grant', permission);
    assert.equal(checkVerdict(timon, permission, undefined), true, permission);
  }
  for (const permission of ['geolocation', 'display-capture', 'midi', 'midiSysex', 'openExternal', 'pointerLock', 'keyboardLock',
    'hid', 'serial', 'usb', 'fileSystem', 'idle-detection', 'window-management', 'storage-access', 'unknown']) {
    assert.equal(requestVerdict(timon, permission, undefined), 'deny', permission);
    assert.equal(checkVerdict(timon, permission, undefined), false, permission);
  }
});

test('origins compare exactly, whatever the path', () => {
  assert.equal(isWindowOrigin(`${ORIGIN}/settings?tab=voice#x`, ORIGIN), true);
  assert.equal(isWindowOrigin(`${ORIGIN}/`, `${ORIGIN}/chat`), true);
  assert.equal(isWindowOrigin('http://127.0.0.1:3110.evil.example/', ORIGIN), false);
  assert.equal(isWindowOrigin('http://user@127.0.0.1:3110/', ORIGIN), true);
  assert.equal(isWindowOrigin('not a url', ORIGIN), false);
});

function prefs(status: string, answer: boolean | Error = true) {
  const calls = { status: 0, ask: 0 };
  const system: SystemMediaAccess = {
    getMediaAccessStatus: () => { calls.status++; return status; },
    askForMediaAccess: () => {
      calls.ask++;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  return { system, calls };
}

test('macOS asks the user once when they never answered', async () => {
  const { system, calls } = prefs('not-determined', true);
  const mic = microphoneAccess('darwin', system);
  const [a, b] = await Promise.all([mic.ensure(), mic.ensure()]);
  assert.deepEqual([a, b], ['granted', 'granted']);
  assert.equal(calls.ask, 1, 'two captures starting together share one prompt');
});

test('macOS: a refusal, a denial or a restriction blocks the capture without a prompt', async () => {
  assert.equal(await microphoneAccess('darwin', prefs('not-determined', false).system).ensure(), 'denied');
  assert.equal(await microphoneAccess('darwin', prefs('not-determined', new Error('tcc')).system).ensure(), 'denied');
  for (const status of ['denied', 'restricted', 'granted'] as const) {
    const { system, calls } = prefs(status);
    assert.equal(await microphoneAccess('darwin', system).ensure(), status);
    assert.equal(calls.ask, 0);
  }
});

test('Windows reports its privacy switch and never prompts; Linux has no gate', async () => {
  const off = prefs('denied');
  assert.equal(await microphoneAccess('win32', off.system).ensure(), 'denied');
  assert.equal(off.calls.ask, 0);
  assert.equal(await microphoneAccess('win32', prefs('granted').system).ensure(), 'granted');
  assert.equal(microphoneAccess('win32', prefs('something-new').system).status(), 'unknown');
  const linux = prefs('denied');
  assert.equal(await microphoneAccess('linux', linux.system).ensure(), 'granted');
  assert.equal(linux.calls.status, 0, 'Linux never reads systemPreferences');
});

type Contents = { id: number };
const WINDOW: Contents = { id: 1 };
const OTHER: Contents = { id: 2 };

function session(mic: MicrophoneAccess, windowOrigin = ORIGIN) {
  type Request = Parameters<PermissionSession<Contents>['setPermissionRequestHandler']>[0];
  type Check = Parameters<PermissionSession<Contents>['setPermissionCheckHandler']>[0];
  let request: Request | null = null;
  let check: Check | null = null;
  const logs: string[] = [];
  installWindowPermissions<Contents>({
    setPermissionRequestHandler: (handler) => { request = handler; },
    setPermissionCheckHandler: (handler) => { check = handler; },
  }, { windowOrigin: () => windowOrigin, isWindow: (contents) => contents === WINDOW, microphone: mic, log: (line) => logs.push(line) });
  const ask = (contents: Contents, permission: string, details: Parameters<Request>[3]) => new Promise<boolean>((resolve) => {
    request!(contents, permission, resolve, details);
  });
  return { ask, check: (...args: Parameters<Check>) => check!(...args), logs };
}

const granted: MicrophoneAccess = { status: () => 'granted', ensure: () => Promise.resolve('granted') };

test('installed handlers: a foreign origin is refused the microphone, and the refusal is logged without its path', async () => {
  const s = session(granted);
  assert.equal(await s.ask(WINDOW, 'media', {
    isMainFrame: true, requestingUrl: 'https://evil.example/steal?token=secret', securityOrigin: 'https://evil.example', mediaTypes: ['audio'],
  }), false);
  assert.equal(s.logs.length, 1);
  assert.ok(!s.logs[0]!.includes('secret'), 'a refused URL is logged as its origin only');
  // The security origin of a media request wins over the URL of the frame.
  assert.equal(await s.ask(WINDOW, 'media', {
    isMainFrame: true, requestingUrl: `${ORIGIN}/chat`, securityOrigin: 'https://evil.example', mediaTypes: ['audio'],
  }), false);
  assert.equal(await s.ask(OTHER, 'media', { isMainFrame: true, securityOrigin: ORIGIN, mediaTypes: ['audio'] }), false);
  assert.equal(s.check(WINDOW, 'media', 'https://evil.example', { isMainFrame: true, mediaType: 'audio' }), false);
  assert.equal(s.check(null, 'media', ORIGIN, { isMainFrame: true, securityOrigin: ORIGIN, mediaType: 'audio' }), false);
});

test('installed handlers: the client service worker may show notifications, and nothing else', () => {
  const s = session(granted);
  assert.equal(s.check(null, 'notifications', ORIGIN, { isMainFrame: false }), true);
  assert.equal(s.check(null, 'notifications', 'http://127.0.0.1:5173', { isMainFrame: false }), false);
  assert.equal(s.check(null, 'clipboard-read', ORIGIN, { isMainFrame: false }), false);
  assert.equal(session(granted, '').check(null, 'notifications', ORIGIN, { isMainFrame: false }), false);
});

test('installed handlers: the window records once the OS agrees', async () => {
  const audio = { isMainFrame: true, requestingUrl: `${ORIGIN}/chat`, securityOrigin: ORIGIN, mediaTypes: ['audio'] as const };
  assert.equal(await session(granted).ask(WINDOW, 'media', audio), true);
  const denied: MicrophoneAccess = { status: () => 'denied', ensure: () => Promise.resolve('denied') };
  const s = session(denied);
  assert.equal(await s.ask(WINDOW, 'media', audio), false);
  assert.match(s.logs[0] ?? '', /blocked by the OS/);
  const failing: MicrophoneAccess = { status: () => 'unknown', ensure: () => Promise.reject(new Error('boom')) };
  assert.equal(await session(failing).ask(WINDOW, 'media', audio), false);
  assert.equal(await session(granted).ask(WINDOW, 'media', { ...audio, mediaTypes: ['audio', 'video'] }), false);
  assert.equal(await session(granted).ask(WINDOW, 'clipboard-read', { isMainFrame: true, requestingUrl: `${ORIGIN}/terminal` }), true);
  assert.equal(session(granted).check(WINDOW, 'media', ORIGIN, { isMainFrame: true, securityOrigin: ORIGIN, mediaType: 'audio' }), true);
  // Before the window loads the client, nothing is granted.
  assert.equal(await session(granted, '').ask(WINDOW, 'media', audio), false);
});
