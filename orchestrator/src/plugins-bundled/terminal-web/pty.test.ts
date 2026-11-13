/**
 * The real spawner end to end: node-pty starts the resolved shell in a
 * cleaned environment, and what the shell prints reaches an attached client.
 * Skipped where the native module does not load.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { TerminalSessions } = await import('../../terminal-host/sessions.js');
const { ensureSpawnHelperExecutable, loadNodePty, nodePtySpawner, ptySpawnOptions } = await import('../../terminal-host/pty.js');
const { defaultCwd, resolveShell, shellEnv } = await import('./shell.js');
const { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');

test('daemon variables never reach the shell, TERM is set', () => {
  const env = shellEnv({ ROOKS_HOME: '/x', ROOKS_API_TOKEN: 'secret', NODE_ENV: 'production', PATH: '/usr/bin', HOME: '/home/u' });
  assert.equal(env.ROOKS_HOME, undefined);
  assert.equal(env.ROOKS_API_TOKEN, undefined);
  assert.equal(env.NODE_ENV, undefined);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.TERM, 'xterm-256color');
});

test('Windows gets PowerShell, POSIX a login shell', () => {
  assert.equal(resolveShell('win32', () => null).shell, 'powershell.exe');
  assert.deepEqual(resolveShell('win32', () => null).args, ['-NoLogo']);
  assert.deepEqual(resolveShell('linux').args, ['-l']);
});

test('Windows prefers PowerShell 7 when it is installed (TIM-0085)', () => {
  const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  assert.deepEqual(resolveShell('win32', () => pwsh), { shell: pwsh, args: ['-NoLogo'] });
  assert.deepEqual(resolveShell('linux', () => pwsh).args, ['-l'], 'other platforms never look for pwsh');
});

test('a real shell runs and streams to the client', { skip: loadNodePty() === null || process.platform === 'win32' }, async () => {
  const sessions = new TerminalSessions({ spawn: nodePtySpawner, idleMs: () => 60_000 });
  try {
    const info = sessions.create('alice', { shell: '/bin/sh', args: [], cwd: defaultCwd(), env: shellEnv() });
    let out = '';
    const handle = sessions.attach('alice', info.id, { send: (m) => { if (m.type === 'output') out += m.data; }, close: () => {} })!;
    handle.input('echo "marker-$((40+2))" && echo "token=${ROOKS_HOME:-none}"\r');
    const deadline = Date.now() + 5_000;
    while (!/token=none/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.match(out, /marker-42/);
    assert.match(out, /token=none/);
  } finally {
    sessions.disposeAll();
  }
});

test('the macOS spawn-helper regains its executable bit, other platforms are left alone', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'npty-'));
  const prebuilt = join(dir, 'prebuilds', 'darwin-arm64');
  mkdirSync(prebuilt, { recursive: true });
  writeFileSync(join(prebuilt, 'spawn-helper'), '');
  chmodSync(join(prebuilt, 'spawn-helper'), 0o644);
  assert.equal(ensureSpawnHelperExecutable(dir, 'linux', 'arm64'), false);
  assert.equal(ensureSpawnHelperExecutable(dir, 'darwin', 'arm64'), true);
  assert.equal(statSync(join(prebuilt, 'spawn-helper')).mode & 0o777, 0o755);
  assert.equal(ensureSpawnHelperExecutable(dir, 'darwin', 'arm64'), false, 'already executable');
});

test('TODO #440: Windows terminals use the ConPTY node-pty ships, other platforms pass no ConPTY option', () => {
  const opts = { shell: 'powershell.exe', args: ['-NoLogo'], cwd: 'C:\\Users\\u', cols: 80, rows: 24, env: { TERM: 'xterm-256color' } };
  const windows = ptySpawnOptions(opts, 'win32');
  assert.equal(windows.useConptyDll, true, 'without it, kill() forks the console-list agent that fails on AttachConsole');
  assert.deepEqual(
    { name: windows.name, cols: windows.cols, rows: windows.rows, cwd: windows.cwd, env: windows.env },
    { name: 'xterm-256color', cols: 80, rows: 24, cwd: opts.cwd, env: opts.env },
  );
  for (const platform of ['linux', 'darwin'] as const) {
    assert.equal('useConptyDll' in ptySpawnOptions(opts, platform), false, platform);
  }
});
