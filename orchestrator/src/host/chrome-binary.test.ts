import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHROME_EXECUTABLE_NAMES, detectChromeBinary, type ChromeProbe } from './chrome-binary.js';

/** A fake disk: the files that exist, the symlinks, the first bytes of scripts. */
function probeOf(files: string[], options: { links?: Record<string, string>; scripts?: Record<string, string> } = {}): ChromeProbe {
  return {
    executable: (file) => files.includes(file),
    realpath: (file) => options.links?.[file] ?? file,
    head: (file) => options.scripts?.[file] ?? '\x7fELF',
  };
}

test('Windows: Chrome per machine, then per user, then Edge', () => {
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\sam\\AppData\\Local' };
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const chromeUser = 'C:\\Users\\sam\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
  const edgeOnly = detectChromeBinary({ platform: 'win32', env, probe: probeOf([edge]) });
  assert.deepEqual(edgeOnly, { found: true, binary: { path: edge, flavour: 'edge', name: 'Microsoft Edge' } });
  const both = detectChromeBinary({ platform: 'win32', env, probe: probeOf([edge, chromeUser]) });
  assert.ok(both.found && both.binary.path === chromeUser && both.binary.flavour === 'chrome');
});

test('macOS: the system Applications folder, then the one of the account', () => {
  const user = '/Users/sam/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const found = detectChromeBinary({ platform: 'darwin', env: {}, homeDir: '/Users/sam', probe: probeOf([user]) });
  assert.ok(found.found && found.binary.path === user);
  const system = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const both = detectChromeBinary({ platform: 'darwin', env: {}, homeDir: '/Users/sam', probe: probeOf([user, system]) });
  assert.ok(both.found && both.binary.path === system);
});

test('Linux: PATH order, Chrome before Edge before Chromium', () => {
  const env = { PATH: '/usr/local/bin:/usr/bin' };
  const chromium = '/usr/bin/chromium';
  const edge = '/usr/bin/microsoft-edge';
  const chrome = '/usr/local/bin/google-chrome';
  const only = detectChromeBinary({ platform: 'linux', env, probe: probeOf([chromium]) });
  assert.ok(only.found && only.binary.flavour === 'chromium');
  const edgeFirst = detectChromeBinary({ platform: 'linux', env, probe: probeOf([chromium, edge]) });
  assert.ok(edgeFirst.found && edgeFirst.binary.flavour === 'edge');
  const all = detectChromeBinary({ platform: 'linux', env, probe: probeOf([chromium, edge, chrome]) });
  assert.ok(all.found && all.binary.path === chrome);
});

test('Linux: a snap or flatpak Chromium is reported as confined, never launched', () => {
  const env = { PATH: '/usr/bin' };
  const viaLink = detectChromeBinary({ platform: 'linux', env, probe: probeOf(['/usr/bin/chromium'], { links: { '/usr/bin/chromium': '/snap/chromium/3000/usr/lib/chromium-browser/chrome' } }) });
  assert.deepEqual(viaLink, { found: false, reason: 'confined' });
  const stub = detectChromeBinary({ platform: 'linux', env, probe: probeOf(['/usr/bin/chromium-browser'], { scripts: { '/usr/bin/chromium-browser': '#!/bin/sh\nexec /snap/bin/chromium "$@"\n' } }) });
  assert.deepEqual(stub, { found: false, reason: 'confined' });
  const flatpak = detectChromeBinary({ platform: 'linux', env, probe: probeOf(['/usr/bin/chromium'], { links: { '/usr/bin/chromium': '/var/lib/flatpak/app/org.chromium.Chromium/x/chromium' } }) });
  assert.deepEqual(flatpak, { found: false, reason: 'confined' });
});

test('Linux: a confined Chromium does not hide a real Chrome that comes later', () => {
  const env = { PATH: '/usr/bin' };
  const found = detectChromeBinary({ platform: 'linux', env, probe: probeOf(['/usr/bin/chromium', '/opt/google/chrome/chrome'],
    { links: { '/usr/bin/chromium': '/snap/chromium/1/chrome' } }) });
  assert.ok(found.found && found.binary.path === '/opt/google/chrome/chrome');
});

test('nothing installed: the reason is "none"', () => {
  assert.deepEqual(detectChromeBinary({ platform: 'linux', env: { PATH: '/usr/bin' }, probe: probeOf([]) }), { found: false, reason: 'none' });
  assert.deepEqual(detectChromeBinary({ platform: 'win32', env: {}, probe: probeOf([]) }), { found: false, reason: 'none' });
});

test('TIMON_CHROME_PATH wins, even a binary under a snap the user vouches for', () => {
  const pinned = '/snap/bin/chromium';
  const found = detectChromeBinary({ platform: 'linux', env: { PATH: '/usr/bin', TIMON_CHROME_PATH: pinned },
    probe: probeOf([pinned, '/usr/bin/google-chrome'], { links: { [pinned]: '/snap/chromium/1/chrome' } }) });
  assert.ok(found.found && found.binary.path === pinned && found.binary.flavour === 'chromium');
});

test('the detection never carries the path in its user-facing name', () => {
  const found = detectChromeBinary({ platform: 'linux', env: { PATH: '/home/sam/bin' }, probe: probeOf(['/home/sam/bin/google-chrome']) });
  assert.ok(found.found && found.binary.name === 'Google Chrome');
});

test('the desktop launches exactly the names the detection can return', async () => {
  // The two packages are built apart and copy this list: read the desktop's own.
  const desktop = await import(new URL('../../../desktop/src/native-browser-chrome.ts', import.meta.url).href) as typeof import('../../../desktop/src/native-browser-chrome.js');
  assert.deepEqual([...desktop.CHROME_EXECUTABLE_NAMES].sort(), [...CHROME_EXECUTABLE_NAMES].sort());
  // Every candidate shape the detection can produce is accepted by the desktop.
  const found = [
    '/usr/bin/google-chrome-stable', '/opt/microsoft/msedge/msedge', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const file of found) assert.equal(desktop.acceptableChromeExecutable(file, 'linux'), true, file);
  for (const file of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Users\\sam\\AppData\\Local\\Chromium\\Application\\chrome.exe',
  ]) assert.equal(desktop.acceptableChromeExecutable(file, 'win32'), true, file);
});
