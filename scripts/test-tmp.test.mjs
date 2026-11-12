import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_NAME, STALE_AFTER_MS, ensureRoot, setupScratch, sweepStale } from './test-tmp.mjs';

// A pid that cannot be alive: kill(0) on it throws ESRCH, so only mtime decides.
const DEAD_PID = 2 ** 22 + 1;

function withRoot(fn) {
  const base = mkdtempSync(join(tmpdir(), 'tt-'));
  try {
    const root = join(base, ROOT_NAME);
    mkdirSync(root);
    fn(root, base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function makeDir(root, name, ageMs) {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'leak.txt'), 'x');
  const at = (Date.now() - ageMs) / 1000;
  utimesSync(dir, at, at);
  return dir;
}

test('sweepStale removes an old sibling and keeps a recent one', () => {
  withRoot((root) => {
    const old = makeDir(root, `${DEAD_PID}-aaaaaa`, STALE_AFTER_MS + 60_000);
    const recent = makeDir(root, `${DEAD_PID}-bbbbbb`, 60_000);
    assert.deepEqual(sweepStale(root), [`${DEAD_PID}-aaaaaa`]);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(recent), true);
  });
});

test('sweepStale keeps an old dir whose owning process is still alive', () => {
  withRoot((root) => {
    const mine = makeDir(root, `${process.pid}-cccccc`, STALE_AFTER_MS + 60_000);
    assert.deepEqual(sweepStale(root), []);
    assert.equal(existsSync(mine), true);
  });
});

test('sweepStale never touches anything outside its root', () => {
  withRoot((root, base) => {
    const outside = makeDir(base, `${DEAD_PID}-dddddd`, STALE_AFTER_MS + 60_000);
    sweepStale(root);
    assert.equal(existsSync(outside), true);
  });
});

test('sweepStale tolerates a missing root', () => {
  assert.deepEqual(sweepStale(join(tmpdir(), 'tt-missing', ROOT_NAME)), []);
});

const POSIX = process.platform !== 'win32';

/** Runs `fn` with TMPDIR/TMP/TEMP restored afterwards, whatever setupScratch did. */
function keepingEnv(fn) {
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('setupScratch creates root and scratch dir owner-only', { skip: !POSIX }, () => {
  keepingEnv(() => {
    const realTmp = mkdtempSync(join(tmpdir(), 'tt-'));
    try {
      const { root, dir, cleanup } = setupScratch({ realTmp });
      assert.equal(statSync(root).mode & 0o777, 0o700);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      cleanup();
    } finally {
      rmSync(realTmp, { recursive: true, force: true });
    }
  });
});

test('ensureRoot narrows an existing root of ours back to 0700', { skip: !POSIX }, () => {
  withRoot((root) => {
    chmodSync(root, 0o775);
    ensureRoot(root);
    assert.equal(statSync(root).mode & 0o777, 0o700);
  });
});

test('setupScratch refuses a symlinked root and leaves its target alone', { skip: !POSIX }, () => {
  keepingEnv(() => {
    const realTmp = mkdtempSync(join(tmpdir(), 'tt-'));
    try {
      const target = join(realTmp, 'victim');
      const old = makeDir(realTmp, 'victim', 0);
      const stale = makeDir(old, `${DEAD_PID}-eeeeee`, STALE_AFTER_MS + 60_000);
      chmodSync(target, 0o755);
      symlinkSync(target, join(realTmp, ROOT_NAME), 'dir');
      assert.throws(() => setupScratch({ realTmp }), /not a real directory/);
      assert.equal(existsSync(stale), true);
      assert.deepEqual(readdirSync(target).sort(), [`${DEAD_PID}-eeeeee`, 'leak.txt']);
      assert.equal(statSync(target).mode & 0o777, 0o755);
      assert.equal(lstatSync(join(realTmp, ROOT_NAME)).isSymbolicLink(), true);
    } finally {
      rmSync(realTmp, { recursive: true, force: true });
    }
  });
});

test('setupScratch refuses a root owned by another uid before sweeping', { skip: !POSIX }, () => {
  keepingEnv(() => {
    const realTmp = mkdtempSync(join(tmpdir(), 'tt-'));
    try {
      const root = join(realTmp, ROOT_NAME);
      mkdirSync(root);
      const stale = makeDir(root, `${DEAD_PID}-ffffff`, STALE_AFTER_MS + 60_000);
      const otherUid = /** @type {number} */ (process.getuid?.()) + 1;
      assert.throws(() => setupScratch({ realTmp, uid: otherUid }), /belongs to uid/);
      assert.equal(existsSync(stale), true);
      assert.deepEqual(readdirSync(root), [`${DEAD_PID}-ffffff`]);
    } finally {
      rmSync(realTmp, { recursive: true, force: true });
    }
  });
});

test('ensureRoot refuses a plain file in place of the root', () => {
  withRoot((_root, base) => {
    const file = join(base, 'not-a-dir');
    writeFileSync(file, 'x');
    assert.throws(() => ensureRoot(file), /not a real directory/);
  });
});

test('setupScratch redirects TMPDIR/TMP/TEMP and cleanup removes the dir', () => {
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  const realTmp = mkdtempSync(join(tmpdir(), 'tt-'));
  try {
    const { root, dir, cleanup } = setupScratch({ realTmp });
    assert.equal(root, join(realTmp, ROOT_NAME));
    assert.ok(dir.startsWith(join(root, `${process.pid}-`)));
    assert.equal(process.env.TMPDIR, dir);
    assert.equal(process.env.TMP, dir);
    assert.equal(process.env.TEMP, dir);
    assert.equal(tmpdir(), dir);
    writeFileSync(join(mkdtempSync(join(tmpdir(), 'leak-')), 'f'), 'x');
    cleanup();
    assert.equal(existsSync(dir), false);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(realTmp, { recursive: true, force: true });
  }
});
