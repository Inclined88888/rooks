/**
 * TODO #476 — the nightly backup keeps what the settings say (`TIMON_BACKUP_KEEP`,
 * `TIMON_BACKUP_MAX_AGE_DAYS`), pruned right after each archive, instead of a
 * hard-coded 7.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-backup-retention-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
delete process.env.TIMON_BACKUP_KEEP;
delete process.env.TIMON_BACKUP_MAX_AGE_DAYS;

import { test } from 'node:test';
import assert from 'node:assert/strict';

const HOME = process.env.TIMON_HOME;
const { backupRetention, backupStatus, backupsDir, pruneBackupArchives, runNightlyBackup, BACKUP_KEEP } = await import('./routines.js');
const { setSetting } = await import('./settings.js');

function archivesIn(dir: string): string[] {
  return readdirSync(dir).filter((n) => /^timon-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(n)).sort();
}

function seedDays(dir: string, month: string, from: number, to: number): void {
  mkdirSync(dir, { recursive: true });
  for (let day = from; day <= to; day++) {
    writeFileSync(join(dir, `timon-2026-${month}-${String(day).padStart(2, '0')}.tar.gz`), `a-${day}`);
  }
}

test('defaults: 7 archives, no age limit', () => {
  assert.deepEqual(backupRetention(), { keep: BACKUP_KEEP, maxAgeDays: 0 });
  const st = backupStatus();
  assert.equal(st.keep, 7);
  assert.equal(st.max_age_days, 0);
});

test('keep: only the N newest survive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-retention-keep-'));
  seedDays(dir, '08', 10, 15);
  writeFileSync(join(dir, 'notes.txt'), 'untouched');
  const dropped = pruneBackupArchives(dir, { keep: 3, maxAgeDays: 0 });
  assert.deepEqual(dropped, ['timon-2026-08-12.tar.gz', 'timon-2026-08-11.tar.gz', 'timon-2026-08-10.tar.gz']);
  assert.deepEqual(readdirSync(dir).sort(), ['notes.txt', 'timon-2026-08-13.tar.gz', 'timon-2026-08-14.tar.gz', 'timon-2026-08-15.tar.gz']);
});

test('max age: archives older than the limit go, even under the count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-retention-age-'));
  seedDays(dir, '08', 1, 20);
  const now = new Date(2026, 7, 20, 3, 31, 0);
  pruneBackupArchives(dir, { keep: 30, maxAgeDays: 5 }, now);
  // Cutoff: 15 Aug 03:31 — the 15th (midnight) is already past it.
  assert.deepEqual(archivesIn(dir), [
    'timon-2026-08-16.tar.gz', 'timon-2026-08-17.tar.gz', 'timon-2026-08-18.tar.gz',
    'timon-2026-08-19.tar.gz', 'timon-2026-08-20.tar.gz',
  ]);
});

test('the newest archive survives an age limit shorter than the gap since it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-retention-newest-'));
  seedDays(dir, '01', 1, 3);
  pruneBackupArchives(dir, { keep: 7, maxAgeDays: 1 }, new Date(2026, 9, 28));
  assert.deepEqual(archivesIn(dir), ['timon-2026-01-03.tar.gz']);
});

test('a numeric retention still means a count (older callers)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-retention-num-'));
  seedDays(dir, '08', 1, 4);
  pruneBackupArchives(dir, 2);
  assert.deepEqual(archivesIn(dir), ['timon-2026-08-03.tar.gz', 'timon-2026-08-04.tar.gz']);
});

test('settings drive the status and the prune that follows a backup', () => {
  assert.deepEqual(setSetting('TIMON_BACKUP_KEEP', '3'), { ok: true });
  assert.deepEqual(setSetting('TIMON_BACKUP_MAX_AGE_DAYS', '30'), { ok: true });
  try {
    const st = backupStatus();
    assert.equal(st.keep, 3);
    assert.equal(st.max_age_days, 30);

    mkdirSync(join(HOME, 'agents', 'witness'), { recursive: true });
    writeFileSync(join(HOME, 'agents', 'witness', 'config.json'), '{}\n');
    seedDays(backupsDir(), '08', 15, 21);
    const result = runNightlyBackup(new Date(2026, 7, 22, 3, 30, 0));
    assert.ok(result.bytes > 0);
    assert.deepEqual(archivesIn(backupsDir()), [
      'timon-2026-08-20.tar.gz', 'timon-2026-08-21.tar.gz', 'timon-2026-08-22.tar.gz',
    ]);
  } finally {
    setSetting('TIMON_BACKUP_KEEP', null);
    setSetting('TIMON_BACKUP_MAX_AGE_DAYS', null);
  }
});

test('keeping zero archives is refused at write time', () => {
  const r = setSetting('TIMON_BACKUP_KEEP', '0');
  assert.equal(r.ok, false);
  assert.equal(backupRetention().keep, 7);
});
