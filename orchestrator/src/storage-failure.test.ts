import test from 'node:test';
import assert from 'node:assert/strict';
import {
  holdOnStorageFailure, lowDiskWarning, LOW_DISK_BYTES, sleepSync, storageFailure, storageFailureMessage,
  storageFailureMonitor,
} from './storage-failure.js';

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

const files = { home: '/data/timon', dbPath: '/data/timon/timon.db' };

test('SQLite storage codes and disk errno are storage failures; data errors are not', () => {
  for (const code of ['SQLITE_IOERR', 'SQLITE_IOERR_WRITE', 'SQLITE_IOERR_SHORT_READ', 'SQLITE_FULL', 'SQLITE_CANTOPEN', 'ENOSPC', 'EIO', 'EDQUOT', 'EROFS']) {
    assert.deepEqual(storageFailure(coded('x', code)), { code, message: 'x' }, code);
  }
  for (const code of ['SQLITE_CONSTRAINT', 'SQLITE_CORRUPT', 'SQLITE_BUSY', 'EADDRINUSE', 'ENOENT']) {
    assert.equal(storageFailure(coded('x', code)), null, code);
  }
  assert.equal(storageFailure(new Error('disk I/O error')), null);
  assert.equal(storageFailure('SQLITE_IOERR'), null);
});

test('the message names the database, the free space and the retry delay', () => {
  const line = storageFailureMessage({ code: 'SQLITE_IOERR', message: 'disk I/O error' }, files, 4.1 * 1024 ** 3, 60_000);
  assert.match(line, /SQLITE_IOERR: disk I\/O error/);
  assert.match(line, /\/data\/timon\/timon\.db/);
  assert.match(line, /4\.1 GiB/);
  assert.match(line, /retries in 60 s/);
  assert.match(storageFailureMessage({ code: 'EIO', message: 'i/o' }, files, null, 1000), /Free space for \/data\/timon: unknown/);
});

test('a storage failure at boot is logged with its stack, waited on, then exits 1', async () => {
  const log: string[] = [];
  const waits: number[] = [];
  const exits: number[] = [];
  await holdOnStorageFailure(coded('disk I/O error', 'SQLITE_IOERR'), files, {
    delayMs: 1234, log: (l) => log.push(l), wait: async (ms) => { waits.push(ms); },
    exit: (code) => exits.push(code), free: () => 10 * 1024 ** 2,
  });
  assert.equal(log.length, 2);
  assert.match(log[0]!, /10 MiB/);
  assert.match(log[1]!, /Error: disk I\/O error/);
  assert.deepEqual(waits, [1234]);
  assert.deepEqual(exits, [1]);
});

test('any other boot error returns at once for the caller to rethrow', async () => {
  let touched = false;
  const touch = () => { touched = true; };
  await holdOnStorageFailure(coded('bad config', 'ECONFIG'), files, {
    log: touch, wait: async () => touch(), exit: touch,
  });
  assert.equal(touched, false);
});

test('low disk warning only below the threshold', () => {
  assert.equal(lowDiskWarning('/h', null), null);
  assert.equal(lowDiskWarning('/h', LOW_DISK_BYTES), null);
  assert.match(lowDiskWarning('/h', 200 * 1024 ** 2) ?? '', /Only 200 MiB free for \/h/);
});

test('after the boot, an uncaught storage failure is logged and waited on once; other errors pass', () => {
  const log: string[] = [];
  const sleeps: number[] = [];
  const monitor = storageFailureMonitor(files, {
    delayMs: 4321, log: (l) => log.push(l), sleep: (ms) => { sleeps.push(ms); }, free: () => null,
  });
  monitor(new Error('boom'));
  monitor(coded('UNIQUE constraint failed', 'SQLITE_CONSTRAINT'));
  assert.deepEqual(sleeps, [], 'only a storage failure delays the crash');
  monitor(coded('database or disk is full', 'SQLITE_FULL'));
  assert.deepEqual(sleeps, [4321]);
  assert.match(log.join('\n'), /\[storage\].*SQLITE_FULL.*retries in 4 s/);
  // A second failure on the way down does not wait again.
  monitor(coded('disk I/O error', 'SQLITE_IOERR'));
  assert.deepEqual(sleeps, [4321]);
});

test('the wait blocks the thread', () => {
  const started = Date.now();
  sleepSync(60);
  assert.ok(Date.now() - started >= 50);
});
