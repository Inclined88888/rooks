import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isMachineId, LOCAL_MACHINE_ID, MACHINE_HEADER, machineForNewWindow, machineNameIn, pageUrl, WINDOW_MACHINE_CHANNEL, windowTitle, withMachineHeader,
  type PinnedWindow,
} from './window-machine.js';

const APP_ORIGIN = 'http://127.0.0.1:3110';
const windows = new Map<number, PinnedWindow>([
  [1, { origin: APP_ORIGIN, machineId: 'vps' }],
  [2, { origin: APP_ORIGIN, machineId: null }],
  [3, { origin: APP_ORIGIN, machineId: LOCAL_MACHINE_ID }],
]);
const lookup = (id: number): PinnedWindow | null => windows.get(id) ?? null;
const request = (over: { url?: string; webContentsId?: number; requestHeaders?: Record<string, string> }) => ({
  url: `${APP_ORIGIN}/api/ui/missions`, requestHeaders: { Accept: 'application/json' }, ...over,
});

test('V3: the copies of the app\'s machine id rules match their source', () => {
  const source = readFileSync(fileURLToPath(new URL('../../app/src/lib/machines/machine-id.ts', import.meta.url)), 'utf8');
  assert.match(source, new RegExp(`LOCAL_MACHINE_ID = '${LOCAL_MACHINE_ID}'`));
  assert.match(source, new RegExp(`MACHINE_HEADER = '${MACHINE_HEADER}'`));
  assert.match(source, /const MACHINE_ID = \/\^\[A-Za-z0-9_-\]\{1,64\}\$\/;/);
  const own = readFileSync(fileURLToPath(new URL('./window-machine.ts', import.meta.url)), 'utf8');
  assert.match(own, /const MACHINE_ID = \/\^\[A-Za-z0-9_-\]\{1,64\}\$\/;/);
});

test('V3: the preload invokes the channel the main process answers', () => {
  const preload = readFileSync(fileURLToPath(new URL('./preload.cts', import.meta.url)), 'utf8');
  assert.ok(preload.includes(`ipcRenderer.invoke('${WINDOW_MACHINE_CHANNEL}', id,`));
});

test('V4: a new page opens on a path of the window\'s own origin, never elsewhere', () => {
  assert.equal(pageUrl(APP_ORIGIN, { route: '/chat?mission=abc' }), `${APP_ORIGIN}/chat?mission=abc`);
  assert.equal(pageUrl(APP_ORIGIN, { route: '/' }), `${APP_ORIGIN}/`);
  for (const bad of [
    undefined, null, 42, {}, { route: 42 }, { route: '' }, { route: 'chat' }, { route: '//evil.example/x' },
    { route: '/\\evil.example' }, { route: '/\t/evil.example' }, { route: 'https://evil.example/' },
    { route: 'javascript:alert(1)' }, { route: `/${'x'.repeat(2048)}` },
  ]) {
    assert.equal(pageUrl(APP_ORIGIN, bad), `${APP_ORIGIN}/`, JSON.stringify(bad));
  }
});

test('V3: a machine id is an id, never a URL or a list', () => {
  for (const ok of ['local', 'vps', 'a_b-C9', 'x'.repeat(64)]) assert.equal(isMachineId(ok), true, ok);
  for (const bad of ['', 'https://vps.example', 'a, b', 'a/b', 'x'.repeat(65), null, 42, undefined]) {
    assert.equal(isMachineId(bad), false, String(bad));
  }
});

test('V3: a pinned window names its machine on every request to its own origin', () => {
  assert.deepEqual(withMachineHeader(request({ webContentsId: 1 }), lookup), { Accept: 'application/json', 'X-Rooks-Machine': 'vps' });
  // `local` is a pin too: this window stays on this computer whatever the cookie says.
  assert.equal(withMachineHeader(request({ webContentsId: 3 }), lookup)['X-Rooks-Machine'], 'local');
});

test('V3: the terminal WebSocket of a pinned window carries the header too', () => {
  const headers = withMachineHeader(request({ webContentsId: 1, url: 'ws://127.0.0.1:3110/api/ui/terminal/ws' }), lookup);
  assert.equal(headers['X-Rooks-Machine'], 'vps');
});

test('V3: a value the page set itself is replaced, never doubled', () => {
  const headers = withMachineHeader(request({ webContentsId: 1, requestHeaders: { 'x-rooks-machine': 'other', Accept: '*/*' } }), lookup);
  assert.deepEqual(headers, { Accept: '*/*', 'X-Rooks-Machine': 'vps' });
});

test('V3: nothing is added for another origin, an unpinned window or a request without a window', () => {
  const plain = { Accept: 'application/json' };
  assert.deepEqual(withMachineHeader(request({ webContentsId: 1, url: 'https://fonts.example.com/a.woff2' }), lookup), plain);
  assert.deepEqual(withMachineHeader(request({ webContentsId: 1, url: 'http://127.0.0.1:3010/api/health' }), lookup), plain);
  assert.deepEqual(withMachineHeader(request({ webContentsId: 2 }), lookup), plain);
  assert.deepEqual(withMachineHeader(request({ webContentsId: 99 }), lookup), plain);
  assert.deepEqual(withMachineHeader(request({}), lookup), plain);
  assert.deepEqual(withMachineHeader(request({ webContentsId: 1, url: 'data:text/plain,x' }), lookup), plain);
});

test('V3: the window title names the machine, from the fleet list', () => {
  const fleet = { machines: [{ id: 'vps', name: ' Office VPS ' }, { id: 'nas', name: '' }] };
  assert.equal(machineNameIn(fleet, 'vps'), 'Office VPS');
  assert.equal(machineNameIn(fleet, 'nas'), null);
  assert.equal(machineNameIn(fleet, 'gone'), null);
  assert.equal(machineNameIn(null, 'vps'), null);
  assert.equal(windowTitle('Rooks', 'Office VPS'), 'Office VPS — Rooks');
  assert.equal(windowTitle('Rooks', null), 'Rooks');
});

test('V3: a new window opens on the machine asked, else the last one used, else the cookie\'s', () => {
  assert.equal(machineForNewWindow('nas', 'vps'), 'nas');
  assert.equal(machineForNewWindow(null, 'vps'), 'vps');
  assert.equal(machineForNewWindow(undefined, null), null);
  assert.equal(machineForNewWindow('https://evil.example', 'bad id'), null);
});
