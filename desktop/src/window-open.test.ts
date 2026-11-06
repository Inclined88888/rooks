import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { machineForDetachedWindow, OPEN_WINDOW_CHANNEL, parseOpenWindowRequest } from './window-open.js';

const ORIGIN = 'http://127.0.0.1:3110';
const source = (name: string): string => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

test('V5: the preload invokes the channel the main process answers', () => {
  assert.ok(source('./preload.cts').includes(`ipcRenderer.invoke('${OPEN_WINDOW_CHANNEL}', request)`));
  assert.ok(source('./main.ts').includes('ipcMain.handle(OPEN_WINDOW_CHANNEL,'));
});

test('V5: a route of the interface opens on the caller\'s origin, fragment dropped', () => {
  assert.deepEqual(parseOpenWindowRequest({ route: '/kanban' }, ORIGIN), { url: `${ORIGIN}/kanban`, machineId: null });
  assert.deepEqual(parseOpenWindowRequest({ route: '/chat/coder?mission=abc#end', machineId: 'vps' }, `${ORIGIN}/somewhere`),
    { url: `${ORIGIN}/chat/coder?mission=abc`, machineId: 'vps' });
  assert.deepEqual(parseOpenWindowRequest({ route: '/', machineId: null }, ORIGIN), { url: `${ORIGIN}/`, machineId: null });
  assert.deepEqual(parseOpenWindowRequest({ route: '/missions' }, 'https://timon.example'), { url: 'https://timon.example/missions', machineId: null });
});

test('V5: anything that could leave the origin is refused, not repaired', () => {
  for (const route of [
    'https://evil.example/', '//evil.example/x', '/\\evil.example', '\\\\evil.example', 'javascript:alert(1)',
    'kanban', '', '/\t/evil.example', '/a b', '/x\u0000', '/x\u007f', `/${'a'.repeat(2048)}`,
  ]) {
    assert.equal(parseOpenWindowRequest({ route }, ORIGIN), null, JSON.stringify(route));
  }
});

test('V5: the request is { route, machineId? } and nothing else', () => {
  for (const input of [
    null, undefined, '/kanban', ['/kanban'], 42, {},
    { route: 42 }, { route: '/kanban', url: 'https://evil.example' }, { route: '/kanban', machineId: 'https://vps' },
    { route: '/kanban', machineId: 'a/b' }, { route: '/kanban', machineId: 7 },
  ]) {
    assert.equal(parseOpenWindowRequest(input, ORIGIN), null, JSON.stringify(input));
  }
});

test('V5: a caller whose origin is not a web page opens nothing', () => {
  assert.equal(parseOpenWindowRequest({ route: '/kanban' }, 'file:///index.html'), null);
  assert.equal(parseOpenWindowRequest({ route: '/kanban' }, ''), null);
  assert.equal(parseOpenWindowRequest({ route: '/kanban' }, 'data:text/html,x'), null);
});

test('V5: a pinned caller keeps its machine; otherwise the page\'s, else the cookie', () => {
  assert.equal(machineForDetachedWindow('vps', 'other'), 'vps');
  assert.equal(machineForDetachedWindow('vps', null), 'vps');
  assert.equal(machineForDetachedWindow(null, 'office'), 'office');
  assert.equal(machineForDetachedWindow(null, null), null);
});

test('V5: the new window is the main process\'s own; navigation rules stay as they were', () => {
  const main = source('./main.ts');
  // The window opens through `createWindow`, and the link handlers keep denying.
  assert.match(main, /function openDetachedWindow\([^)]*\): boolean \{[\s\S]*?createWindow\(url,/);
  assert.match(main, /setWindowOpenHandler\(\(\{ url: target \}\) => \{\n\s*const external = externalUrl\(target\);\n\s*if \(external\) void shell\.openExternal\(external\);\n\s*return \{ action: 'deny' \};/);
  // Only a Timon window of its own origin asks, as for the window's machine.
  assert.match(main, /ipcMain\.handle\(OPEN_WINDOW_CHANNEL, \(event, input: unknown\) => \{\n\s*const caller = senderWindow\(event\);\n\s*if \(!caller \|\| !canReadAppInfo\(senderOf\(event\), caller\.origin\)\) throw/);
});
