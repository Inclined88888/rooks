/**
 * Detached launches: the process starts, writes to its log, and is not a
 * child of the caller any more once the Windows-style intermediate has left.
 * The systemd scope is not exercised here — tests never create units.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnInNewSession, spawnOrphan, type DetachedSpec } from './detached.js';

const ORCHESTRATOR = fileURLToPath(new URL('../../', import.meta.url));

function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (cond()) resolve();
      else if (Date.now() > deadline) reject(new Error('condition not met in time'));
      else setTimeout(tick, 25);
    };
    tick();
  });
}

function stop(pid: number | null): void {
  if (pid === null || pid <= 0) return;
  try { process.kill(pid); } catch { /* already gone */ }
}

/** A child that writes its parent pid after the intermediate had time to leave, then waits. */
function spec(dir: string): DetachedSpec {
  const out = join(dir, 'ppid');
  const script = `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(out)}, String(process.ppid)); console.log('child up'); }, 400); setTimeout(() => {}, 20000);`;
  return { cmd: process.execPath, args: ['-e', script], env: { ...process.env }, cwd: ORCHESTRATOR, logFile: join(dir, 'log', 'child.log'), name: 'rooks-test' };
}

test('a new session: the child runs, its output lands in the log', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'detached-'));
  const s = spec(dir);
  const result = await spawnInNewSession(s);
  try {
    assert.equal(result.via, 'new-session');
    assert.ok(result.pid && result.pid > 0);
    await until(() => existsSync(join(dir, 'ppid')) && readFileSync(s.logFile, 'utf8').includes('child up'));
  } finally {
    stop(result.pid);
  }
});

test('an orphan: started by an intermediate that left, so no process tree of ours reaches it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'detached-'));
  const s = spec(dir);
  const result = await spawnOrphan(s, {
    execPath: process.execPath,
    execArgv: ['--import', 'tsx'],
    runner: fileURLToPath(new URL('./detach-runner.ts', import.meta.url)),
  });
  try {
    assert.equal(result.via, 'orphan');
    assert.ok(result.pid && result.pid > 0, 'the intermediate reports the final pid');
    await until(() => existsSync(join(dir, 'ppid')));
    assert.notEqual(Number(readFileSync(join(dir, 'ppid'), 'utf8')), process.pid);
  } finally {
    stop(result.pid);
  }
});

test('an orphan whose command cannot start is an error, not a silent success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'detached-'));
  await assert.rejects(spawnOrphan({ ...spec(dir), cmd: join(dir, 'missing-binary') }, {
    execPath: process.execPath,
    execArgv: ['--import', 'tsx'],
    runner: fileURLToPath(new URL('./detach-runner.ts', import.meta.url)),
  }), /could not start rooks-test/);
});
