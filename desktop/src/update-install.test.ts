/**
 * The assisted installation of P3 (docs/AUTO-UPDATE.md §5): an AppImage is
 * replaced only once its copy is verified, and a failure keeps the running one;
 * the missions are counted on whichever daemon runs, old or new.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DaemonAnswerError, appImageBackupPath, debInstallCommand, missionsAtStake, readMissionCount, removeAppImageBackup, replaceAppImage,
  type AppImageFs,
} from './update-install.js';

const NEW = Buffer.from('the new AppImage');
const NEW_SHA = createHash('sha256').update(NEW).digest('hex');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'rooks appimage '));
  const appImage = join(dir, 'Rooks 0.1.7.AppImage');
  writeFileSync(appImage, 'the running AppImage', { mode: 0o750 });
  const verified = join(mkdtempSync(join(tmpdir(), 'rooks updates ')), 'Rooks-0.1.8.AppImage');
  writeFileSync(verified, NEW, { mode: 0o644 });
  return { dir, appImage, verified };
}

/** The real file system, with one operation replaced. */
async function realFs(): Promise<AppImageFs> {
  const { access, chmod, copyFile, link, rename, rm, stat } = await import('node:fs/promises');
  const { sha256Of } = await import('./update-download.js');
  return {
    access, copyFile, link, rename, chmod, sha256: sha256Of,
    rm: (path) => rm(path, { force: true }),
    mode: async (path) => (await stat(path)).mode & 0o7777,
  };
}

test('the verified AppImage replaces the running one, executable, and the previous one waits beside it', { skip: process.platform === 'win32' }, async () => {
  const s = setup();
  const outcome = await replaceAppImage({ appImage: s.appImage, verified: s.verified, sha256: NEW_SHA });
  assert.equal(outcome.status, 'replaced');
  assert.deepEqual(readFileSync(s.appImage), NEW);
  assert.equal(statSync(s.appImage).mode & 0o111, 0o111);
  assert.equal(readFileSync(appImageBackupPath(s.appImage), 'utf8'), 'the running AppImage');
  assert.equal(existsSync(join(s.dir, '.Rooks 0.1.7.AppImage.rooks-update')), false);
  if (outcome.status !== 'replaced') return;
  await outcome.restore();
  assert.equal(readFileSync(s.appImage, 'utf8'), 'the running AppImage');
});

test('a copy that does not hash to the signed sha256 replaces nothing and leaves nothing behind', async () => {
  const s = setup();
  await assert.rejects(replaceAppImage({ appImage: s.appImage, verified: s.verified, sha256: 'f'.repeat(64) }), /changed while it was copied/);
  assert.equal(readFileSync(s.appImage, 'utf8'), 'the running AppImage');
  assert.equal(existsSync(appImageBackupPath(s.appImage)), false);
  assert.equal(existsSync(join(s.dir, '.Rooks 0.1.7.AppImage.rooks-update')), false);
});

test('a replacement that fails at the last rename keeps the running AppImage', async () => {
  const s = setup();
  const fs = await realFs();
  const failing: AppImageFs = { ...fs, rename: async () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); } };
  await assert.rejects(replaceAppImage({ appImage: s.appImage, verified: s.verified, sha256: NEW_SHA }, failing), /EBUSY/);
  assert.equal(readFileSync(s.appImage, 'utf8'), 'the running AppImage');
  assert.equal(existsSync(appImageBackupPath(s.appImage)), false);
});

test('without hard links, the previous AppImage is copied', async () => {
  const s = setup();
  const fs = await realFs();
  const outcome = await replaceAppImage({ appImage: s.appImage, verified: s.verified, sha256: NEW_SHA },
    { ...fs, link: async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } });
  assert.equal(outcome.status, 'replaced');
  assert.equal(readFileSync(appImageBackupPath(s.appImage), 'utf8'), 'the running AppImage');
});

test('a folder that cannot be written: nothing is touched, and it is said', async () => {
  const s = setup();
  const fs = await realFs();
  let copied = false;
  const outcome = await replaceAppImage({ appImage: s.appImage, verified: s.verified, sha256: NEW_SHA }, {
    ...fs,
    access: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    copyFile: async () => { copied = true; },
  });
  assert.deepEqual(outcome, { status: 'not_writable' });
  assert.equal(copied, false);
  assert.equal(readFileSync(s.appImage, 'utf8'), 'the running AppImage');
});

test('a relative AppImage path is refused before anything is read', async () => {
  await assert.rejects(replaceAppImage({ appImage: 'Rooks.AppImage', verified: '/x', sha256: NEW_SHA }), /not absolute/);
});

test('the new version removes the previous AppImage once it runs', async () => {
  const s = setup();
  await replaceAppImage({ appImage: s.appImage, verified: s.verified, sha256: NEW_SHA });
  await removeAppImageBackup(s.appImage);
  assert.equal(existsSync(appImageBackupPath(s.appImage)), false);
  assert.deepEqual(readFileSync(s.appImage), NEW);
  await removeAppImageBackup(undefined);
});

test('the .deb command quotes its path for a POSIX shell', () => {
  assert.equal(debInstallCommand('/home/a b/.rooks/updates/0.1.8/rooks_0.1.8_amd64.deb'),
    "sudo apt install '/home/a b/.rooks/updates/0.1.8/rooks_0.1.8_amd64.deb'");
  assert.equal(debInstallCommand("/home/o'neil/x.deb"), "sudo apt install '/home/o'\\''neil/x.deb'");
});

test('missions: the route of this version, the live count of an older daemon, nothing from a daemon that cannot tell', async () => {
  const asked: string[] = [];
  const answers = (table: Record<string, unknown>) => async (path: string) => {
    asked.push(path);
    const value = table[path];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new DaemonAnswerError(404);
    return value;
  };
  assert.deepEqual(await readMissionCount(answers({ '/api/updates/missions': { live: 3, working: 1 } })), { live: 3, working: 1 });
  assert.deepEqual(await readMissionCount(answers({ '/api/health/resources': { liveMissions: 2, load1: 0.3 } })), { live: 2, working: null });
  asked.length = 0;
  // A refusal is not an older daemon: no second question.
  assert.equal(await readMissionCount(answers({ '/api/updates/missions': new DaemonAnswerError(401) })), null);
  assert.deepEqual(asked, ['/api/updates/missions']);
  assert.equal(await readMissionCount(answers({ '/api/updates/missions': new TypeError('fetch failed') })), null);
  assert.equal(await readMissionCount(answers({ '/api/updates/missions': { live: -1, working: 'x' } })), null);
  assert.equal(await readMissionCount(answers({})), null);
  assert.equal(missionsAtStake({ live: 3, working: 1 }), 1);
  assert.equal(missionsAtStake({ live: 2, working: null }), 2);
  assert.equal(missionsAtStake(null), 0);
});
