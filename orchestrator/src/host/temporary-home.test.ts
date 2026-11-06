import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOW_TEMPORARY_HOME_FLAG, temporaryHomeNotice, underTemporaryDir } from './temporary-home.js';

const none = () => null;

test('#464: a home under the OS temporary folder is recognised, a sibling is not', () => {
  assert.equal(underTemporaryDir('/tmp/tmp.AbC123', { platform: 'linux', tmp: '/tmp', realpath: none }), true);
  assert.equal(underTemporaryDir('/tmp', { platform: 'linux', tmp: '/tmp', realpath: none }), true);
  assert.equal(underTemporaryDir('/tmpfoo/home', { platform: 'linux', tmp: '/tmp', realpath: none }), false);
  assert.equal(underTemporaryDir('/home/t/.timon', { platform: 'linux', tmp: '/tmp', realpath: none }), false);
  // Case matters on Linux only.
  assert.equal(underTemporaryDir('/TMP/x', { platform: 'linux', tmp: '/tmp', realpath: none }), false);
  assert.equal(underTemporaryDir('/Var/Folders/ab/T/x', { platform: 'darwin', tmp: '/var/folders/ab/T', realpath: none }), true);
});

test('#464: macOS — a home spelled through /private still counts', () => {
  // `mktemp -d` prints /var/folders/…, the realpath of TMPDIR is /private/var/folders/….
  const realpath = (path: string) => (path.startsWith('/var/') ? `/private${path}` : path);
  assert.equal(underTemporaryDir('/private/var/folders/ab/T/tmp.x', { platform: 'darwin', tmp: '/var/folders/ab/T', realpath }), true);
});

test('#464: the real temporary folder of this machine, and the real home', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-temp-home-'));
  try {
    assert.equal(underTemporaryDir(dir), true);
    assert.equal(underTemporaryDir(join(dir, 'not-created-yet')), true);
    assert.equal(underTemporaryDir(join(homedir(), '.timon')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#464: refused without the flag, a warning with it, silence elsewhere', () => {
  const opts = { platform: 'linux' as const, tmp: '/tmp', realpath: none };
  const refused = temporaryHomeNotice('/tmp/tmp.rc', false, opts);
  assert.equal(refused?.refuse, true);
  assert.ok(refused.lines.some((line) => line.includes(ALLOW_TEMPORARY_HOME_FLAG)));
  assert.ok(refused.lines.some((line) => line.includes('timon service uninstall')));
  const allowed = temporaryHomeNotice('/tmp/tmp.rc', true, opts);
  assert.equal(allowed?.refuse, false);
  assert.match(allowed.lines[0]!, /^warning: /);
  assert.equal(temporaryHomeNotice('/home/t/.timon', false, opts), null);
});
