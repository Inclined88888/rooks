import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hardenHomePermissions, ownerOnlyTargets } from './home-permissions.js';
import type { SyncExec } from './host/owner-only.js';

const posix = process.platform !== 'win32';
const modeOf = (path: string) => statSync(path).mode & 0o777;

function file(path: string, mode: number): void {
  writeFileSync(path, 'x');
  chmodSync(path, mode);
}
function dir(path: string, mode: number): void {
  mkdirSync(path, { recursive: true });
  chmodSync(path, mode);
}

test('an existing install is restricted at start, never widened, worktrees left alone', { skip: !posix }, () => {
  const home = join(mkdtempSync(join(tmpdir(), 'timon-home-perms-')), '.timon');
  dir(home, 0o775);
  file(join(home, 'timon.db'), 0o644);
  file(join(home, 'timon.db-wal'), 0o644);
  file(join(home, 'timon.db-shm'), 0o644);
  file(join(home, 'timon.config.json'), 0o664);
  file(join(home, 'timon.config.json.bak-20261025'), 0o664);
  file(join(home, 'secrets.env'), 0o644);
  file(join(home, 'license.key'), 0o400);
  dir(join(home, 'backups'), 0o775);
  file(join(home, 'backups', 'timon-2026-11-03.tar.gz'), 0o664);
  file(join(home, 'backups', 'pre-rebuild-2026-10-31.db'), 0o644);
  dir(join(home, 'mcp'), 0o775);
  file(join(home, 'mcp', 'ext-stripe.json'), 0o664);
  // Set explicitly: a recursive mkdir would leave it at the umask's mode (0755 under 022).
  dir(join(home, 'worktrees'), 0o775);
  dir(join(home, 'worktrees', 'task'), 0o775);
  file(join(home, 'worktrees', 'task', 'index.ts'), 0o664);
  file(join(home, 'roles.json'), 0o664);

  const { report, acl } = hardenHomePermissions(home);
  assert.equal(acl, null);
  assert.deepEqual(report.failed, []);

  assert.equal(modeOf(home), 0o700);
  for (const name of ['timon.db', 'timon.db-wal', 'timon.db-shm', 'timon.config.json', 'timon.config.json.bak-20261025', 'secrets.env']) {
    assert.equal(modeOf(join(home, name)), 0o600, name);
  }
  assert.equal(modeOf(join(home, 'license.key')), 0o400, 'never widened');
  assert.equal(modeOf(join(home, 'backups')), 0o700);
  assert.equal(modeOf(join(home, 'backups', 'timon-2026-11-03.tar.gz')), 0o600);
  assert.equal(modeOf(join(home, 'backups', 'pre-rebuild-2026-10-31.db')), 0o600);
  assert.equal(modeOf(join(home, 'mcp', 'ext-stripe.json')), 0o600);
  // Covered by the home's 0700, not walked.
  assert.equal(modeOf(join(home, 'worktrees')), 0o775);
  assert.equal(modeOf(join(home, 'worktrees', 'task', 'index.ts')), 0o664);
  assert.equal(modeOf(join(home, 'roles.json')), 0o664);

  // Second start: nothing left to do.
  assert.deepEqual(hardenHomePermissions(home).report.tightened, []);
});

test('a failing chmod does not stop the sweep nor the start', () => {
  const warnings: string[] = [];
  const { report } = hardenHomePermissions('/srv/timon', {
    platform: 'linux',
    list: () => [],
    stat: () => ({ mode: 0o100644 }) as ReturnType<typeof statSync>,
    chmod: () => { throw new Error('read-only file system'); },
    warn: (message) => warnings.push(message),
  });
  assert.equal(report.tightened.length, 0);
  assert.equal(report.failed.length, ownerOnlyTargets('/srv/timon', () => []).length);
  assert.ok(warnings.every((w) => w.startsWith('[perms] ')));
});

test('a home widened again between two starts is restricted again', { skip: !posix }, () => {
  const home = join(mkdtempSync(join(tmpdir(), 'timon-home-perms-')), '.timon');
  dir(home, 0o755);
  file(join(home, 'timon.db'), 0o644);
  hardenHomePermissions(home);
  assert.equal(modeOf(home), 0o700);
  assert.equal(modeOf(join(home, 'timon.db')), 0o600);
  // Opened again by hand between two starts.
  chmodSync(home, 0o755);
  chmodSync(join(home, 'timon.db'), 0o644);
  const { report } = hardenHomePermissions(home);
  assert.deepEqual(report.tightened, [home, join(home, 'timon.db')]);
  assert.equal(modeOf(home), 0o700);
  assert.equal(modeOf(join(home, 'timon.db')), 0o600);
});

test('under win32 the home goes through the ACL adapter, never chmod, with the secret files checked', () => {
  const reads: string[][] = [];
  let chmods = 0;
  const sid = 'S-1-5-21-1-2-3-1001';
  const exec: SyncExec = (_file, _args, { env }) => {
    const paths = env.TIMON_ACL_PATHS!.split('\n');
    reads.push(paths);
    return { code: 0, stdout: [sid, ...paths.map((_p, i) => `${i}\t${i === 0 ? `D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)` : '-'}`)].join('\r\n'), stderr: '' };
  };
  const home = 'C:\\Users\\robin\\.timon';
  const { report, acl } = hardenHomePermissions(home, {
    platform: 'win32',
    list: () => [],
    chmod: () => { chmods += 1; },
    windows: { exec, log: () => {}, warn: () => {} },
  });
  assert.deepEqual(report, { tightened: [], failed: [] });
  assert.equal(acl, 'unchanged');
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0], ownerOnlyTargets(home, () => []));
  for (const name of ['timon.db', 'timon.db-wal', 'timon.db-shm', 'daemon-token', 'secret-key', 'license.jwt']) {
    assert.ok(reads[0]!.includes(join(home, name)), name);
  }
  assert.equal(chmods, 0);
});
