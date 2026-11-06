/**
 * TODO #476 — the nightly backup is on by default, new installs and existing
 * ones alike, without ever re-arming a backup someone turned off.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-backup-default-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { applyBackupDefault, backupStatus, BACKUP_DEFAULT_KEY, BACKUP_ROUTINE_ID, enableBackupRoutine, startRoutines, updateRoutine } = await import('./routines.js');
const { dbApi } = await import('./db.js');

/** Back to an install that predates the default: no marker, no routine. */
function predateDefault(): void {
  dbApi.deleteSetting(BACKUP_DEFAULT_KEY);
  dbApi.deleteRoutine(BACKUP_ROUTINE_ID);
}

test('a home that never configured the backup gets it enabled, once', () => {
  assert.equal(backupStatus().routine, null);
  assert.equal(applyBackupDefault(), 'created');
  const st = backupStatus();
  assert.equal(st.enabled, true);
  assert.equal(st.cron, '30 3 * * *');
  assert.ok(st.next_run_at && st.next_run_at > Date.now());
  assert.ok(dbApi.getAllSettings()[BACKUP_DEFAULT_KEY], 'the marker is recorded');
  assert.equal(applyBackupDefault(), 'already');
  assert.equal(dbApi.listRoutines().filter((r) => r.id === BACKUP_ROUTINE_ID).length, 1);
});

test('a backup the user turned off before the upgrade stays off', () => {
  predateDefault();
  enableBackupRoutine();
  updateRoutine(BACKUP_ROUTINE_ID, { enabled: false });
  assert.equal(applyBackupDefault(), 'kept');
  assert.equal(backupStatus().enabled, false);
  assert.equal(applyBackupDefault(), 'already');
  assert.equal(backupStatus().enabled, false);
});

test('turned off or deleted after the default, it is never re-armed', () => {
  predateDefault();
  assert.equal(applyBackupDefault(), 'created');
  updateRoutine(BACKUP_ROUTINE_ID, { enabled: false });
  assert.equal(applyBackupDefault(), 'already');
  assert.equal(backupStatus().enabled, false);
  dbApi.deleteRoutine(BACKUP_ROUTINE_ID);
  assert.equal(applyBackupDefault(), 'already');
  assert.equal(backupStatus().routine, null);
});

test('the routines module applies the default when it starts', () => {
  predateDefault();
  const stop = startRoutines();
  try {
    assert.equal(backupStatus().enabled, true);
  } finally {
    stop();
  }
});
