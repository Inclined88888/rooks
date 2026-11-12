import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { CookiesSetDetails } from 'electron';
import { ChromeSignin, type ChromeChild, type ChromeSpawn } from './native-browser-chrome-signin.js';
import { PipeFrames, framePipeMessage } from './native-browser-chrome.js';

const NOW_SECONDS = Math.floor(Date.now() / 1000);
const GOOGLE = { name: 'SID', value: 'secret', domain: '.google.com', path: '/', expires: NOW_SECONDS + 86_400, session: false, secure: true, httpOnly: true, sameSite: 'None' };
const PARTITIONED = { ...GOOGLE, name: 'CHIPS', partitionKey: { topLevelSite: 'https://example.com' } };

/** A Chrome that answers DevTools commands on its pipe and exits on Browser.close. */
function fakeChrome(options: { cookies?: unknown[]; ignoreClose?: boolean; failReads?: boolean } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = new PipeFrames();
  const exits: Array<() => void> = [];
  const state = { exited: false, killed: false, commands: [] as string[], args: [] as string[], cookies: options.cookies ?? [GOOGLE] };
  const exit = () => { if (state.exited) return; state.exited = true; for (const listener of exits) listener(); };
  input.on('data', (chunk: Buffer) => {
    for (const text of frames.push(chunk)) {
      const request = JSON.parse(text) as { id: number; method: string };
      state.commands.push(request.method);
      if (request.method === 'Storage.getCookies') {
        if (!options.failReads) output.write(framePipeMessage({ id: request.id, result: { cookies: state.cookies } }));
      } else if (request.method === 'Browser.close') {
        output.write(framePipeMessage({ id: request.id, result: {} }));
        if (!options.ignoreClose) setImmediate(exit);
      }
    }
  });
  const child: ChromeChild = {
    input, output,
    onExit: (listener) => { exits.push(listener); },
    kill: () => { state.killed = true; exit(); },
  };
  const spawn: ChromeSpawn = (_executable, args) => { state.args = args; return child; };
  return { spawn, state, exit };
}

function harness(t: { after(fn: () => void): void }, fake: ReturnType<typeof fakeChrome>) {
  const home = mkdtempSync(join(tmpdir(), 'rooks-chrome-signin-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stored: CookiesSetDetails[] = [];
  const jar = { set: async (details: CookiesSetDetails) => { stored.push(details); } };
  const logs: string[] = [];
  const signin = new ChromeSignin({
    home, spawn: fake.spawn, platform: 'linux', exists: () => true, pollMs: 20, exitGraceMs: 50, log: (line) => logs.push(line),
  });
  return { home, stored, jar, logs, signin };
}
const executable = { executable: '/usr/bin/google-chrome' };
const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

test('finishing copies the cookies into the session and closes the window', async (t) => {
  const fake = fakeChrome({ cookies: [GOOGLE, PARTITIONED] });
  const { stored, jar, signin, home } = harness(t, fake);
  assert.deepEqual(await signin.start('bp-1', executable, jar), { state: 'open' });
  assert.ok(fake.state.args.includes('--remote-debugging-pipe'));
  assert.ok(fake.state.args.some((arg) => arg === `--user-data-dir=${join(home, 'browser-profiles', 'bp-1', 'chrome')}`));
  assert.equal(fake.state.args.at(-1), 'https://accounts.google.com/');
  assert.equal(statSync(join(home, 'browser-profiles', 'bp-1', 'chrome')).isDirectory(), true);
  await settle();
  const result = await signin.finish('bp-1');
  assert.deepEqual(result, { state: 'finished', imported: 1, skipped: 1 });
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.name, 'SID');
  assert.ok(fake.state.commands.includes('Browser.close'));
  assert.equal(fake.state.exited, true);
  assert.deepEqual(signin.status('bp-1'), { state: 'finished', imported: 1, skipped: 1 });
});

test('closing the window by hand keeps the last reading', async (t) => {
  const fake = fakeChrome();
  const { stored, jar, signin } = harness(t, fake);
  await signin.start('bp-1', executable, jar);
  await settle();
  fake.exit();
  await settle();
  assert.deepEqual(signin.status('bp-1'), { state: 'finished', imported: 1, skipped: 0 });
  assert.equal(stored.length, 1);
});

test('a browser that exits before anything was read is a failure, not a silent success', async (t) => {
  const fake = fakeChrome({ failReads: true });
  const { stored, jar, signin } = harness(t, fake);
  await signin.start('bp-1', executable, jar);
  fake.exit();
  await settle();
  const status = signin.status('bp-1');
  assert.equal(status.state, 'failed');
  assert.match(status.error ?? '', /No sign-in could be read/);
  assert.equal(stored.length, 0);
});

test('cancelling closes the window and copies nothing', async (t) => {
  const fake = fakeChrome();
  const { stored, jar, signin } = harness(t, fake);
  await signin.start('bp-1', executable, jar);
  await settle();
  assert.deepEqual(await signin.cancel('bp-1'), { state: 'idle' });
  assert.equal(stored.length, 0);
  assert.equal(fake.state.exited, true);
});

test('a browser that ignores Browser.close is killed', async (t) => {
  const fake = fakeChrome({ ignoreClose: true });
  const { jar, signin } = harness(t, fake);
  await signin.start('bp-1', executable, jar);
  await settle();
  const result = await signin.cancel('bp-1');
  assert.equal(result.state, 'idle');
  assert.equal(fake.state.killed, true);
});

test('a second start while a window is open launches nothing new', async (t) => {
  let launches = 0;
  const fake = fakeChrome();
  const { home, jar } = harness(t, fake);
  const signin = new ChromeSignin({ home, spawn: (...args) => { launches += 1; return fake.spawn(...args); }, platform: 'linux', exists: () => true, pollMs: 20, log: () => {} });
  await signin.start('bp-1', executable, jar);
  assert.deepEqual(await signin.start('bp-1', executable, jar), { state: 'open' });
  assert.equal(launches, 1);
  await signin.cancel('bp-1');
});

test('the binary and the address are validated before anything is spawned', async (t) => {
  const fake = fakeChrome();
  const { home, jar } = harness(t, fake);
  let launches = 0;
  const signin = new ChromeSignin({ home, spawn: (...args) => { launches += 1; return fake.spawn(...args); }, platform: 'linux', exists: () => true, log: () => {} });
  await assert.rejects(signin.start('bp-1', { executable: '/bin/sh' }, jar), /cannot be used to sign in/);
  await assert.rejects(signin.start('bp-1', { executable: 'google-chrome' }, jar), /cannot be used to sign in/);
  await assert.rejects(signin.start('bp-1', { ...executable, url: 'file:///etc/passwd' }, jar), /HTTP and HTTPS/);
  await assert.rejects(signin.start('../x', executable, jar), /Invalid browser profile ID/);
  const missing = new ChromeSignin({ home, spawn: fake.spawn, platform: 'linux', exists: () => false, log: () => {} });
  await assert.rejects(missing.start('bp-1', executable, jar), /no longer installed/);
  assert.equal(launches, 0);
  assert.equal(existsSync(join(home, 'browser-profiles', 'bp-1', 'chrome')), false);
});

test('no cookie value ever reaches the log', async (t) => {
  const fake = fakeChrome();
  const { jar, signin, logs } = harness(t, fake);
  await signin.start('bp-1', executable, jar);
  await settle();
  await signin.finish('bp-1');
  assert.ok(logs.length > 0);
  for (const line of logs) assert.ok(!line.includes('secret'), line);
});

test('closeAll copies an open sign-in before the app quits', async (t) => {
  const fake = fakeChrome();
  const { stored, jar, signin } = harness(t, fake);
  await signin.start('bp-1', executable, jar);
  await settle();
  await signin.closeAll();
  assert.equal(stored.length, 1);
});
