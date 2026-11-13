/** Plugin folders in a copy, and the copy itself on Windows and on a small disk. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateSync, symlinkSync, lstatSync, readlinkSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPendingRestore,
  copyLink,
  MAX_PLUGIN_BACKUP_BYTES,
  snapshotRequiredBytes,
  readSnapshotProgress,
  backupsDir,
  DataSnapshotError,
  protectDataBeforeOpen,
  readDataVersion,
  readSnapshotFailure,
  readSnapshotMeta,
  writeDataVersion,
  type SnapshotMeta,
} from './data-version.js';
import { home, seed, notes, quiet, requestRestore, downgraded, liveState, leftovers, windowsRename, seedPlugins, treeState } from './data-version-fixtures.js';

test('plugins and their data restore exactly, including empty directories and removal of new plugins', () => {
  const files = downgraded();
  seedPlugins(files, 'after');
  writeFileSync(join(files.home, 'plugins', 'new-plugin'), 'new');
  requestRestore(files, 'pre-0.1.2', '0.1.1');
  assert.equal(applyPendingRestore(files, '0.1.1', { rename: windowsRename })?.ok, true);
  const snapshot = join(backupsDir(files.home), 'pre-0.1.2');
  for (const slot of ['plugins', 'plugins-data']) {
    assert.equal(treeState(join(files.home, slot)), treeState(join(snapshot, slot)));
    assert.equal(readFileSync(join(backupsDir(files.home), 'before-restore', slot, 'sample', 'state'), 'utf8'), 'after');
  }
});

test('absent plugin folders are recorded and restore removes folders installed since', () => {
  const files = home();
  seed(files, 'old').close();
  writeDataVersion(files.home, '0.1.1');
  protectDataBeforeOpen(files, '0.1.2', quiet);
  seedPlugins(files, 'new');
  requestRestore(files, 'pre-0.1.2', '0.1.1');
  assert.equal(applyPendingRestore(files, '0.1.1')?.ok, true);
  assert.equal(existsSync(join(files.home, 'plugins')), false);
  assert.equal(existsSync(join(files.home, 'plugins-data')), false);
});

test('damaged or missing saved plugin content prevents every live change', () => {
  for (const remove of [false, true]) {
    const files = downgraded();
    const before = liveState(files);
    const file = join(backupsDir(files.home), 'pre-0.1.2', 'plugins-data', 'sample', 'state');
    if (remove) rmSync(file); else writeFileSync(file, 'damaged');
    requestRestore(files, 'pre-0.1.2', '0.1.1');
    assert.equal(applyPendingRestore(files, '0.1.1')?.ok, false);
    assert.deepEqual(liveState(files), before);
  }
});

test('plugin space is counted and insufficient space yields an explicit partial copy only for additive changes', () => {
  for (const destructive of [false, true]) {
    const files = home();
    seed(files, 'old').close();
    writeDataVersion(files.home, '0.1.1');
    const base = snapshotRequiredBytes(files);
    seedPlugins(files, 'x'.repeat(1024 * 1024));
    assert.ok(snapshotRequiredBytes(files) > base + 2 * 1024 * 1024);
    const options = { ...quiet, availableBytes: () => base + 1024, destructive: destructive ? [{ id: 'pending', breaks: [], applied: () => false }] : [] };
    if (destructive) {
      assert.throws(() => protectDataBeforeOpen(files, '0.1.2', options), DataSnapshotError);
      assert.equal(readDataVersion(files.home), '0.1.1');
      assert.equal(existsSync(join(backupsDir(files.home), 'pre-0.1.2')), false);
    } else {
      assert.equal(protectDataBeforeOpen(files, '0.1.2', options), 'snapshot');
      assert.match(readSnapshotFailure(files.home)?.message ?? '', /partial backup/);
      const meta = readSnapshotMeta(join(backupsDir(files.home), 'pre-0.1.2'));
      assert.equal(meta?.pluginCopies?.plugins.state, 'omitted');
      seedPlugins(files, 'keep');
      requestRestore(files, 'pre-0.1.2', '0.1.1');
      assert.equal(applyPendingRestore(files, '0.1.1')?.ok, true);
      assert.equal(readFileSync(join(files.home, 'plugins-data', 'sample', 'state'), 'utf8'), 'keep');
    }
  }
});

test('the automatic size limit avoids copying huge plugin data and announces a partial backup', () => {
  const files = home();
  seed(files, 'old').close();
  seedPlugins(files, 'x');
  // Sparse file: exercises the real limit without allocating a GiB in the test runner.
  truncateSync(join(files.home, 'plugins-data', 'sample', 'state'), MAX_PLUGIN_BACKUP_BYTES + 1);
  protectDataBeforeOpen(files, '0.1.2', quiet);
  assert.match(readSnapshotFailure(files.home)?.message ?? '', /1 GiB/);
  // Never retried for this version: the desktop tells it once (TIM-0068).
  assert.equal(readSnapshotFailure(files.home)?.partial, true);
  assert.equal(JSON.parse(readFileSync(join(backupsDir(files.home), 'snapshot-failure.json'), 'utf8')).partial, true);
  assert.equal(existsSync(join(backupsDir(files.home), 'pre-0.1.2', 'plugins')), false);
});

for (const snapshotKind of ['omitted', 'legacy', 'saved'] as const) {
  test(`oversized current plugins ${snapshotKind === 'saved' ? 'prevent' : 'allow'} restoration of a ${snapshotKind} snapshot`, () => {
    const files = downgraded();
    seed(files, 'after the update').close();
    const metaPath = join(backupsDir(files.home), 'pre-0.1.2', 'snapshot.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as SnapshotMeta;
    if (snapshotKind === 'legacy') delete meta.pluginCopies;
    if (snapshotKind === 'omitted') {
      meta.pluginCopies = { plugins: { state: 'omitted' }, 'plugins-data': { state: 'omitted' } };
      meta.partial = 'Plugin data exceeded the automatic backup limit';
    }
    writeFileSync(metaPath, JSON.stringify(meta));
    const dataFile = join(files.home, 'plugins-data', 'sample', 'state');
    truncateSync(dataFile, MAX_PLUGIN_BACKUP_BYTES + 1);
    const before = statSync(dataFile);
    const pluginsBefore = treeState(join(files.home, 'plugins'));
    requestRestore(files, 'pre-0.1.2', '0.1.1');
    const result = applyPendingRestore(files, '0.1.1', { rename: windowsRename });
    assert.equal(result?.ok, snapshotKind !== 'saved');
    assert.equal(treeState(join(files.home, 'plugins')), pluginsBefore);
    assert.equal(statSync(dataFile).size, before.size);
    assert.equal(statSync(dataFile).mtimeMs, before.mtimeMs);
    assert.equal(statSync(dataFile).ino, before.ino);
    assert.deepEqual(leftovers(files), []);
    if (snapshotKind === 'saved') {
      assert.match(result?.error ?? '', /Cannot back up your current plugins before restoration .*1 GiB.*restoration cancelled/);
      assert.deepEqual(notes(files.dbPath), ['before the update', 'after the update']);
      assert.equal(readFileSync(files.configPath, 'utf8'), '{"v":"0.1.2"}');
      assert.equal(readDataVersion(files.home), '0.1.2');
    } else {
      assert.deepEqual(notes(files.dbPath), ['before the update']);
      assert.equal(readFileSync(files.configPath, 'utf8'), '{"v":"0.1.1"}');
      assert.equal(readDataVersion(files.home), '0.1.1');
      const safety = join(backupsDir(files.home), 'before-restore');
      assert.deepEqual(notes(join(safety, 'rooks.db')), ['before the update', 'after the update']);
      assert.equal(readFileSync(join(safety, 'rooks.config.json'), 'utf8'), '{"v":"0.1.2"}');
      assert.equal(readSnapshotMeta(safety)?.pluginCopies?.['plugins-data'].state, 'omitted');
    }
  });
}

test('a partial scan preserves known absence and restoration removes plugins installed since', () => {
  const files = home();
  seed(files, 'old').close();
  seedPlugins(files, 'old');
  rmSync(join(files.home, 'plugins'), { recursive: true });
  const dataFile = join(files.home, 'plugins-data', 'sample', 'state');
  truncateSync(dataFile, MAX_PLUGIN_BACKUP_BYTES + 1);
  writeDataVersion(files.home, '0.1.1');
  protectDataBeforeOpen(files, '0.1.2', quiet);
  const meta = readSnapshotMeta(join(backupsDir(files.home), 'pre-0.1.2'));
  assert.deepEqual(meta?.pluginCopies, { plugins: { state: 'absent' }, 'plugins-data': { state: 'omitted' } });
  seedPlugins(files, 'new');
  const dataBefore = treeState(join(files.home, 'plugins-data'));
  requestRestore(files, 'pre-0.1.2', '0.1.1');
  assert.equal(applyPendingRestore(files, '0.1.1', { rename: windowsRename })?.ok, true);
  assert.equal(existsSync(join(files.home, 'plugins')), false);
  assert.equal(treeState(join(files.home, 'plugins-data')), dataBefore);
  assert.equal(readFileSync(join(backupsDir(files.home), 'before-restore', 'plugins', 'sample', 'state'), 'utf8'), 'new');
});

test('legacy snapshots and legacy recovery journals leave plugin directories alone', () => {
  const files = downgraded();
  const file = join(backupsDir(files.home), 'pre-0.1.2', 'snapshot.json');
  const meta = JSON.parse(readFileSync(file, 'utf8')) as SnapshotMeta;
  delete meta.pluginCopies;
  writeFileSync(file, JSON.stringify(meta));
  const before = treeState(join(files.home, 'plugins'));
  requestRestore(files, 'pre-0.1.2', '0.1.1');
  assert.equal(applyPendingRestore(files, '0.1.1')?.ok, true);
  assert.equal(treeState(join(files.home, 'plugins')), before);
  writeFileSync(join(backupsDir(files.home), 'restore-journal.json'), JSON.stringify({ id: 'old', snapshot: 'pre-0.1.2', present: ['db', 'config', 'data-version'] }));
  applyPendingRestore(files, '0.1.1');
  assert.equal(treeState(join(files.home, 'plugins')), before);
});

test('copy progress is persisted before plugin copying and completes with its byte count', () => {
  const files = home();
  seed(files, 'old').close();
  seedPlugins(files, '12345');
  const phases: string[] = [];
  const start = performance.now();
  protectDataBeforeOpen(files, '0.1.2', { ...quiet, progress: (value) => {
    phases.push(value.phase);
    assert.deepEqual(readSnapshotProgress(files.home), value);
  } });
  assert.deepEqual(phases, ['scanning', 'database', 'plugins', 'plugins', 'plugins', 'complete']);
  assert.equal(readSnapshotProgress(files.home)?.copiedBytes, 10);
  assert.ok(performance.now() - start < 5000);
});

test('a plugin swap interrupted during rollback recovers through the same journal', () => {
  const files = downgraded();
  const before = liveState(files);
  requestRestore(files, 'pre-0.1.2', '0.1.1');
  assert.throws(() => applyPendingRestore(files, '0.1.1', {
    fault: (at) => { if (at === 'swap:plugins-data') throw new Error('swap failed'); },
    rename: (from, to) => {
      if (from === join(files.home, 'plugins-data.restore-old')) throw new Error('locked');
      windowsRename(from, to);
    },
  }), /could not be undone/);
  assert.ok(existsSync(join(backupsDir(files.home), 'restore-journal.json')));
  applyPendingRestore(files, '0.1.1', { rename: windowsRename });
  assert.deepEqual(liveState(files), before);
  assert.deepEqual(leftovers(files), []);
});

test('no room even for the database keeps the previous version and records failure', () => {
  const files = downgraded();
  const before = liveState(files);
  assert.equal(protectDataBeforeOpen(files, '0.1.3', { ...quiet, availableBytes: () => 0 }), 'unprotected');
  assert.deepEqual(liveState(files), before);
  assert.equal(readSnapshotProgress(files.home)?.phase, 'failed');
  assert.equal(existsSync(join(backupsDir(files.home), 'pre-0.1.3')), false);
});

test('plugin links keep their literal target without reading or copying external content', { skip: process.platform === 'win32' }, () => {
  const files = home();
  seed(files, 'old').close();
  seedPlugins(files, 'old');
  const external = mkdtempSync(join(tmpdir(), 'rooks-plugin-external-'));
  writeFileSync(join(external, 'private'), 'external');
  symlinkSync(external, join(files.home, 'plugins-data', 'linked'));
  protectDataBeforeOpen(files, '0.1.2', quiet);
  const link = join(backupsDir(files.home), 'pre-0.1.2', 'plugins-data', 'linked');
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readlinkSync(link), external);
  rmSync(join(files.home, 'plugins-data', 'linked'));
  requestRestore(files, 'pre-0.1.2', '0.1.1');
  assert.equal(applyPendingRestore(files, '0.1.1')?.ok, true);
  assert.equal(readlinkSync(join(files.home, 'plugins-data', 'linked')), external);
  assert.equal(readFileSync(join(external, 'private'), 'utf8'), 'external');
});

test('a representative plugin copy stays bounded and exposes progress', (t) => {
  const files = home();
  seed(files, 'old').close();
  seedPlugins(files, 'old');
  const payload = Buffer.alloc(64 * 1024, 42);
  for (let index = 0; index < 256; index++) writeFileSync(join(files.home, 'plugins-data', `file-${index}`), payload);
  const start = performance.now();
  protectDataBeforeOpen(files, '0.1.2', quiet);
  const elapsed = performance.now() - start;
  assert.equal(readSnapshotFailure(files.home), null);
  assert.ok(elapsed < 30_000);
  assert.ok((readSnapshotProgress(files.home)?.copiedBytes ?? 0) >= 16 * 1024 * 1024);
  t.diagnostic(`16 MiB / 256 files copied and verified in ${Math.round(elapsed)} ms`);
});

test('failed restore removes staged plugins when the live folders were absent', () => {
  const files = downgraded();
  for (const slot of ['plugins', 'plugins-data']) rmSync(join(files.home, slot), { recursive: true });
  const before = liveState(files);
  requestRestore(files, 'pre-0.1.2', '0.1.1');
  assert.equal(applyPendingRestore(files, '0.1.1', {
    rename: windowsRename,
    fault: (at) => { if (at === 'swap:plugins-data') throw new Error('injected'); },
  })?.ok, false);
  assert.deepEqual(liveState(files), before);
  assert.deepEqual(leftovers(files), []);
});

test('TIM-0028: a directory link Windows refuses as a symlink is recreated as a junction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rooks-link-'));
  const external = mkdtempSync(join(tmpdir(), 'rooks-plugin-external-'));
  symlinkSync(external, join(dir, 'quota-monitor'));
  const calls: Array<[string, string, string | undefined]> = [];
  copyLink(join(dir, 'quota-monitor'), join(dir, 'copy'), (target, path, type) => {
    calls.push([target, path, type]);
    if (!type) throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' });
  });
  assert.deepEqual(calls, [
    [external, join(dir, 'copy'), undefined],
    [external, join(dir, 'copy'), 'junction'],
  ]);
});

test('TIM-0028: a junction is only a fallback for directories, other failures still fail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rooks-link-'));
  writeFileSync(join(dir, 'file'), 'x');
  symlinkSync(join(dir, 'file'), join(dir, 'file-link'));
  const eperm = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  assert.throws(() => copyLink(join(dir, 'file-link'), join(dir, 'copy'), eperm), /EPERM/);
  const exists = () => { throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); };
  symlinkSync(dir, join(dir, 'dir-link'));
  assert.throws(() => copyLink(join(dir, 'dir-link'), join(dir, 'copy'), exists), /EEXIST/);
});

test('plugins written to while they are copied are copied again instead of announcing a partial backup', () => {
  const files = home();
  seed(files, 'old').close();
  writeDataVersion(files.home, '0.1.1');
  seedPlugins(files, 'before');
  let touched = false;
  const progress = (value: { phase: string }) => {
    if (value.phase !== 'plugins' || touched) return;
    touched = true;
    writeFileSync(join(files.home, 'plugins', 'sample', 'state'), 'written meanwhile');
  };
  assert.equal(protectDataBeforeOpen(files, '0.1.2', { ...quiet, progress }), 'snapshot');
  assert.equal(touched, true);
  assert.equal(readSnapshotFailure(files.home), null);
  const saved = join(backupsDir(files.home), 'pre-0.1.2', 'plugins', 'sample', 'state');
  assert.equal(readFileSync(saved, 'utf8'), 'written meanwhile');
});

test('a relative link inside the plugins is no change between the plugins and their copy', () => {
  const files = home();
  seed(files, 'old').close();
  writeDataVersion(files.home, '0.1.1');
  seedPlugins(files, 'x');
  symlinkSync(join('sample', 'state'), join(files.home, 'plugins', 'alias'));
  assert.equal(protectDataBeforeOpen(files, '0.1.2', quiet), 'snapshot');
  assert.equal(readSnapshotFailure(files.home), null);
  assert.equal(readlinkSync(join(backupsDir(files.home), 'pre-0.1.2', 'plugins', 'alias')), join('sample', 'state'));
});

test('TIM-0077: a database copy longer than the plugin time limit still backs up the plugins', (t) => {
  const files = home();
  seed(files, 'old').close();
  writeDataVersion(files.home, '0.1.1');
  seedPlugins(files, 'x');
  const realNow = Date.now.bind(Date);
  let elapsed = 0;
  t.mock.method(Date, 'now', () => realNow() + elapsed);
  // The database copy of a long-used install on a scanned Windows disk takes longer than the plugin limit.
  const progress = (value: { phase: string }) => { if (value.phase === 'database') elapsed += 31_000; };
  assert.equal(protectDataBeforeOpen(files, '0.1.2', { ...quiet, progress }), 'snapshot');
  assert.equal(readSnapshotFailure(files.home), null);
  assert.equal(readSnapshotMeta(join(backupsDir(files.home), 'pre-0.1.2'))?.partial, undefined);
  assert.equal(readFileSync(join(backupsDir(files.home), 'pre-0.1.2', 'plugins', 'sample', 'state'), 'utf8'), 'x');
});

test('a backup folder Windows keeps locked for a moment is published once the lock goes', () => {
  const files = home();
  seed(files, 'old').close();
  writeDataVersion(files.home, '0.1.1');
  seedPlugins(files, 'x');
  let refused = 0;
  const rename = (from: string, to: string) => {
    if (to.endsWith('pre-0.1.2') && refused < 2) {
      refused++;
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
    }
    renameSync(from, to);
  };
  assert.equal(protectDataBeforeOpen(files, '0.1.2', { ...quiet, rename }), 'snapshot');
  assert.equal(refused, 2);
  assert.equal(readSnapshotFailure(files.home), null);
  assert.deepEqual(notes(join(backupsDir(files.home), 'pre-0.1.2', 'rooks.db')), ['old']);
});

test('a backup folder that stays unwritable still fails, without retrying other errors forever', () => {
  const files = home();
  seed(files, 'old').close();
  writeDataVersion(files.home, '0.1.1');
  let calls = 0;
  const rename = (from: string, to: string) => {
    if (!to.endsWith('pre-0.1.2')) { renameSync(from, to); return; }
    calls++;
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  };
  assert.equal(protectDataBeforeOpen(files, '0.1.2', { ...quiet, rename }), 'unprotected');
  assert.equal(calls, 1);
  assert.match(readSnapshotFailure(files.home)?.message ?? '', /ENOSPC/);
  assert.equal(readDataVersion(files.home), '0.1.1');
});

test('a progress file that cannot be replaced does not fail the backup', () => {
  const files = home();
  seed(files, 'old').close();
  writeDataVersion(files.home, '0.1.1');
  seedPlugins(files, 'x');
  // A directory in its place: every replacement of the progress file fails, as under a Windows lock.
  mkdirSync(join(backupsDir(files.home), 'snapshot-progress.json', 'held'), { recursive: true });
  const phases: string[] = [];
  assert.equal(protectDataBeforeOpen(files, '0.1.2', { ...quiet, progress: (value) => phases.push(value.phase) }), 'snapshot');
  assert.equal(readSnapshotFailure(files.home), null);
  assert.equal(readSnapshotMeta(join(backupsDir(files.home), 'pre-0.1.2'))?.partial, undefined);
  assert.deepEqual(phases, ['scanning', 'database', 'plugins', 'plugins', 'plugins', 'complete']);
});

test('TIM-0068: the desktop reads a partial backup recorded by the daemon as partial, and says it once', async () => {
  const files = home();
  seed(files, 'old').close();
  writeDataVersion(files.home, '0.1.3');
  seedPlugins(files, 'x');
  writeFileSync(join(files.home, 'plugins-data', 'sample', 'state'), '');
  truncateSync(join(files.home, 'plugins-data', 'sample', 'state'), MAX_PLUGIN_BACKUP_BYTES + 1);
  assert.equal(protectDataBeforeOpen(files, '0.1.4', quiet), 'snapshot');
  // The desktop package copies the file format: read it with the desktop's own code.
  const desktop = await import(new URL('../../desktop/src/data-restore.ts', import.meta.url).href) as typeof import('../../desktop/src/data-restore.js');
  const warning = desktop.unshownSnapshotWarning(files.home, '0.1.4');
  assert.equal(warning?.partial, true);
  assert.equal(warning?.blocking, false);
  assert.equal(warning?.at, readSnapshotFailure(files.home)?.at);
  assert.match(desktop.snapshotFailureDialog(warning!, 'en').message, /but not your plugins/);
  desktop.markSnapshotWarningShown(files.home, warning!);
  assert.equal(desktop.unshownSnapshotWarning(files.home, '0.1.4'), null);
});
