import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareVersions,
  keepCurrentData,
  requestRestore,
  restoreDialog,
  restoreOffer,
  restoreOutcome,
  restorePending,
  markSnapshotWarningShown,
  snapshotFailure,
  snapshotFailureDialog,
  unshownSnapshotWarning,
} from './data-restore.js';

/** What a 0.1.2 daemon leaves behind: data-version and the copy made before it migrated. */
function afterUpdate(): string {
  const home = mkdtempSync(join(tmpdir(), 'timon-restore-'));
  writeFileSync(join(home, 'data-version'), '0.1.2\n');
  const dir = join(home, 'backups', 'pre-0.1.2');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'timon.db'), '');
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify({ from: '0.1.1', to: '0.1.2', createdAt: 1_700_000_000_000 }));
  return home;
}

test('compareVersions matches the daemon', () => {
  assert.equal(compareVersions('0.1.2', '0.1.1'), 1);
  assert.equal(compareVersions('0.2.0-beta.1', '0.2.0'), -1);
  assert.equal(compareVersions('dev', '0.1.0'), null);
  assert.equal(compareVersions('0.1.6-rc.10', '0.1.6-rc.9'), 1, 'rc.10 is not older than rc.9');
  assert.equal(compareVersions('1.0.0-beta.11', '1.0.0-rc.1'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
});

test('an older version is offered the copy made before the newer one', () => {
  const home = afterUpdate();
  try {
    assert.deepEqual(restoreOffer(home, '0.1.1'), { dataVersion: '0.1.2', snapshot: 'pre-0.1.2', createdAt: 1_700_000_000_000 });
    assert.deepEqual(restoreOffer(home, '0.1.0'), { dataVersion: '0.1.2', snapshot: 'pre-0.1.2', createdAt: 1_700_000_000_000 });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('no question for the same or a newer version, nor without a copy', () => {
  const home = afterUpdate();
  try {
    assert.equal(restoreOffer(home, '0.1.2'), null);
    assert.equal(restoreOffer(home, '0.1.3'), null);
    rmSync(join(home, 'backups', 'pre-0.1.2', 'timon.db'));
    assert.equal(restoreOffer(home, '0.1.1'), null);
    rmSync(join(home, 'data-version'));
    assert.equal(restoreOffer(home, '0.1.1'), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Continue makes this version the owner of the data: the question is not asked again', () => {
  const home = afterUpdate();
  try {
    keepCurrentData(home, '0.1.1');
    assert.equal(readFileSync(join(home, 'data-version'), 'utf8'), '0.1.1\n');
    assert.equal(restoreOffer(home, '0.1.1'), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Restore writes a request for this version only, and the question is not asked again meanwhile', () => {
  const home = afterUpdate();
  try {
    const offer = restoreOffer(home, '0.1.1');
    assert.ok(offer);
    const request = requestRestore(home, offer, '0.1.1', 5);
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'backups', 'restore-request.json'), 'utf8')), request);
    assert.equal(request.version, '0.1.1');
    assert.equal(request.snapshot, 'pre-0.1.2');
    assert.equal(restorePending(home, request.id), true);
    assert.equal(restoreOffer(home, '0.1.1'), null);
    // Nothing else in the data directory changed.
    assert.equal(readFileSync(join(home, 'data-version'), 'utf8'), '0.1.2\n');

    assert.equal(restoreOutcome(home, request.id), null);
    rmSync(join(home, 'backups', 'restore-request.json'));
    writeFileSync(join(home, 'backups', 'last-restore.json'), JSON.stringify({ id: request.id, snapshot: 'pre-0.1.2', ok: false, error: 'disk full', at: 6 }));
    assert.equal(restorePending(home, request.id), false);
    assert.deepEqual(restoreOutcome(home, request.id), { ok: false, error: 'disk full' });
    assert.equal(restoreOutcome(home, 'another'), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the dialog says what is lost, keeps the data by default, in English and French', () => {
  const offer = { dataVersion: '0.1.2', snapshot: 'pre-0.1.2', createdAt: 1_700_000_000_000 };
  const en = restoreDialog(offer, '0.1.1', '/home/sam/.timon', 'en-US');
  assert.equal(en.defaultId, 0);
  assert.equal(en.cancelId, 0);
  assert.match(en.buttons[0]!, /Continue/);
  assert.match(en.buttons[1]!, /Restore/);
  assert.match(en.detail, /will be lost/);
  assert.match(en.detail, /before-restore/);
  const fr = restoreDialog(offer, '0.1.1', '/home/sam/.timon', 'fr');
  assert.match(fr.buttons[1]!, /Restaurer/);
  assert.match(fr.detail, /sera perdu/);
});

test('a failed copy is shown only to the version that made it, blocking or not', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-desktop-restore-'));
  assert.equal(snapshotFailure(home, '0.1.1'), null);
  mkdirSync(join(home, 'backups'), { recursive: true });
  const file = join(home, 'backups', 'snapshot-failure.json');
  writeFileSync(file, JSON.stringify({ version: '0.1.1', message: 'Timon 0.1.1 did not start', at: 1, blocking: true }));
  assert.deepEqual(snapshotFailure(home, '0.1.1'), { message: 'Timon 0.1.1 did not start', blocking: true, at: 1 });
  assert.equal(snapshotFailure(home, '0.1.2'), null);
  writeFileSync(file, JSON.stringify({ version: '0.1.1', message: 'started without a copy', at: 1, blocking: false }));
  assert.equal(snapshotFailure(home, '0.1.1')?.blocking, false);
  const failure = { message: 'x', blocking: true };
  assert.match(snapshotFailureDialog(failure, 'fr-FR').message, /sauvegarder/);
  assert.equal(snapshotFailureDialog(failure, 'en-US').detail, 'x');
});

test('TIM-0068: a partial backup is announced as such, once, while each start without a copy is announced again', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-desktop-restore-'));
  mkdirSync(join(home, 'backups'), { recursive: true });
  const file = join(home, 'backups', 'snapshot-failure.json');
  writeFileSync(file, JSON.stringify({ version: '0.1.4', message: 'Timon 0.1.4 saved a partial backup', at: 10, blocking: false, partial: true }));
  const partial = unshownSnapshotWarning(home, '0.1.4');
  assert.deepEqual(partial, { message: 'Timon 0.1.4 saved a partial backup', blocking: false, partial: true, at: 10 });
  assert.match(snapshotFailureDialog(partial!, 'en-US').message, /backed up your data .* but not your plugins/);
  assert.doesNotMatch(snapshotFailureDialog(partial!, 'fr-FR').message, /pas pu/);
  markSnapshotWarningShown(home, partial!);
  // The daemon stopped, the desktop relaunched: same failure, already said.
  assert.equal(unshownSnapshotWarning(home, '0.1.4'), null);
  // A start without a copy retries and records a new attempt: said again.
  writeFileSync(file, JSON.stringify({ version: '0.1.4', message: 'started without saving a copy', at: 11, blocking: false }));
  assert.equal(unshownSnapshotWarning(home, '0.1.4')?.at, 11);
  // A refusal to start is never filtered: main.ts shows it through its own paths.
  writeFileSync(file, JSON.stringify({ version: '0.1.4', message: 'did not start', at: 12, blocking: true }));
  assert.equal(unshownSnapshotWarning(home, '0.1.4'), null);
  // A failure written before attempts were dated keeps being shown.
  writeFileSync(file, JSON.stringify({ version: '0.1.4', message: 'old format', blocking: false }));
  markSnapshotWarningShown(home, { message: 'old format', blocking: false });
  assert.equal(unshownSnapshotWarning(home, '0.1.4')?.message, 'old format');
  rmSync(home, { recursive: true, force: true });
});
