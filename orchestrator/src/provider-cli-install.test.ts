/**
 * The installer's console as the screen shows it (TODO #251, SUG-0005): its
 * lines while it runs, without colours or the thousand redraws of a progress
 * bar, bounded, and a job stopped when it outlives its timeout.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

const { ConsoleLog, cliInstallDone, cliInstallJob, resetCliInstallsForTests, startCliInstall, streamingExec } = await import('./provider-cli-install.js');

function fakeChild(): ChildProcess & { stdout: PassThrough; stderr: PassThrough } {
  const child = new EventEmitter() as ChildProcess & { stdout: PassThrough; stderr: PassThrough };
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough() });
  return child;
}

test('a progress bar keeps its last state, colours and blank lines go', () => {
  const log = new ConsoleLog();
  log.push('\u001b[1mInstalling\u001b[0m Claude Code\n');
  log.push('  10%\r  55%\r 100%\r\n\n');
  log.push('\u001b]0;title\u0007Done');
  assert.deepEqual(log.lines, ['Installing Claude Code', ' 100%']);
  log.flush();
  assert.deepEqual(log.lines, ['Installing Claude Code', ' 100%', 'Done']);
});

test('the console is bounded: the oldest lines go, and how many is said', () => {
  const log = new ConsoleLog();
  for (let i = 0; i < 320; i += 1) log.push(`line ${i}\n`);
  assert.equal(log.lines.length, 300);
  assert.equal(log.dropped, 20);
  assert.equal(log.lines[0], 'line 20');
  log.push(`${'x'.repeat(900)}\n`);
  assert.equal(log.lines.at(-1)?.length, 501);
});

test('each line reaches the log as it is printed, and the exit code the caller', async () => {
  const child = fakeChild();
  const log = new ConsoleLog();
  const done = streamingExec('/bin/sh', ['-c', 'x'], log, { spawn: () => child, kill: () => {} });
  child.stdout.write('first\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log.lines, ['first']);
  child.stderr.write('warning: slow\n');
  await new Promise((resolve) => setImmediate(resolve));
  child.emit('close', 3, null);
  const res = await done;
  assert.equal(res.code, 3);
  assert.match(res.stderr, /warning: slow/);
  assert.deepEqual(log.lines, ['first', 'warning: slow']);
});

test('an installer that outlives its timeout is stopped, and says so', async () => {
  const child = fakeChild();
  let killed = false;
  const log = new ConsoleLog();
  const res = await streamingExec('/bin/sh', ['-c', 'x'], log, { spawn: () => child, kill: () => { killed = true; }, timeoutMs: 20 });
  assert.equal(killed, true);
  assert.equal(res.code, 124);
  assert.match(log.lines.at(-1) ?? '', /stopped after/);
});

test('a program that cannot start is an answer, not a throw', async () => {
  const res = await streamingExec('powershell', [], new ConsoleLog(), { spawn: () => { throw new Error('spawn powershell ENOENT'); } });
  assert.equal(res.code, 127);
  assert.match(res.stderr, /ENOENT/);
});

test('a job: one per CLI, joined while it runs, its verdict kept once it ends', async () => {
  resetCliInstallsForTests();
  let calls = 0;
  let finish: (() => void) | null = null;
  const deps = {
    platform: 'linux' as const,
    exec: async (_command: string, _args: string[], log: InstanceType<typeof ConsoleLog>) => {
      calls += 1;
      log.push('working\n');
      await new Promise<void>((resolve) => { finish = resolve; });
      return { code: 1, stdout: '', stderr: 'curl: (6) Could not resolve host' };
    },
    locate: () => null,
  };
  const first = startCliInstall('claude', deps);
  const second = startCliInstall('claude', deps);
  assert.equal(calls, 1);
  assert.equal(first.state, 'running');
  assert.equal(second.startedAt, first.startedAt);
  assert.throws(() => startCliInstall('opencode', { ...deps, platform: 'win32' }), /no official installer/);
  (finish as (() => void) | null)?.();
  const result = await cliInstallDone('claude');
  assert.equal(result?.ok, false);
  const job = cliInstallJob('claude');
  assert.equal(job?.state, 'failed');
  assert.match(job?.result?.reason ?? '', /Could not resolve host \(exit 1\)/);
  assert.deepEqual(job?.lines, ['working']);
  assert.equal(cliInstallJob('codex'), null);
});

test('after a success the daemon looks for its CLIs again, before the job says it succeeded', async () => {
  resetCliInstallsForTests();
  const order: string[] = [];
  startCliInstall('codex', {
    platform: 'darwin',
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    locate: () => '/Users/ann/.local/bin/codex',
    afterSuccess: () => { order.push(`recheck:${cliInstallJob('codex')?.state}`); },
  });
  await cliInstallDone('codex');
  assert.deepEqual(order, ['recheck:running']);
  assert.equal(cliInstallJob('codex')?.state, 'succeeded');
});
