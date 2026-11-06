import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataOpenLockTimeoutError, holdDataOpenLock, releaseDataOpenLock } from './data-open-lock.js';

const lockModule = new URL('./data-open-lock.ts', import.meta.url).href;

/** A second process holding the lock until it is told to let go, or killed. */
async function holder(home: string): Promise<{ child: ChildProcess; release: () => Promise<void> }> {
  const script = join(home, 'holder.mjs');
  writeFileSync(script, `
    const { holdDataOpenLock, releaseDataOpenLock } = await import(${JSON.stringify(lockModule)});
    holdDataOpenLock(process.env.TIMON_HOME);
    console.log('held');
    process.stdin.once('data', () => { releaseDataOpenLock(process.env.TIMON_HOME); console.log('released'); });
  `);
  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    env: { ...process.env, TIMON_HOME: home, TIMON_RESOURCE_GUARD_ENABLED: '0' }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  let output = '';
  const seen = (word: string) => new Promise<void>((resolve, reject) => {
    const check = () => { if (output.includes(word)) resolve(); };
    child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); check(); });
    child.once('exit', (code) => { if (!output.includes(word)) reject(new Error(`holder exited (${code}) before "${word}"`)); });
    check();
  });
  await seen('held');
  return { child, release: async () => { child.stdin!.write('go\n'); await seen('released'); } };
}

test('a packaged process waits for the one holding the data lock, then takes it (TODO #592)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'timon-data-lock-'));
  const other = await holder(home);
  t.after(() => { other.child.kill('SIGKILL'); rmSync(home, { recursive: true, force: true }); });

  const warnings: string[] = [];
  assert.throws(() => holdDataOpenLock(home, { waitMs: 300, warn: (m) => warnings.push(m) }), DataOpenLockTimeoutError);
  assert.match(warnings.join('\n'), /another Timon process is saving and converting your data/);

  await other.release();
  holdDataOpenLock(home, { waitMs: 5_000, warn: () => assert.fail('nothing holds it any more') });
  // Holding it already: a second call (the waiting daemon, then db.ts) returns at once.
  holdDataOpenLock(home, { waitMs: 0 });
  releaseDataOpenLock(home);
  releaseDataOpenLock(home);
});

test('the data lock of a process that died is free at once: nothing to clear by hand (TODO #592)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'timon-data-lock-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const other = await holder(home);
  const exited = new Promise((resolve) => other.child.once('exit', resolve));
  other.child.kill('SIGKILL');
  await exited;
  holdDataOpenLock(home, { waitMs: 5_000, warn: () => assert.fail('a dead process holds nothing') });
  releaseDataOpenLock(home);
});

test('a lock that cannot be taken for another reason only warns: Timon still starts (TODO #592)', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'timon-data-lock-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // `backups` is a file: neither the directory nor the lock can be created.
  writeFileSync(join(home, 'backups'), 'not a directory');
  const warnings: string[] = [];
  holdDataOpenLock(home, { waitMs: 0, warn: (m) => warnings.push(m) });
  assert.match(warnings.join('\n'), /continuing without the lock/);
  releaseDataOpenLock(home);
});
