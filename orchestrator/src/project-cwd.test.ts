/**
 * TIM-0083 — the cwd classification. `existsSync` folded ENOENT, EPERM and
 * ENOTDIR into "absent"; the report must keep them apart, and the log line
 * must fire on a change only (statuses are polled every few seconds per card).
 */
import './test-home.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Stats } from 'node:fs';
import { checkCwd } from './project-cwd.js';

function failing(code: string): () => Stats {
  return () => { throw Object.assign(new Error(code), { code }); };
}

function captureWarnings(fn: () => void): string[] {
  const seen: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { seen.push(args.join(' ')); };
  try { fn(); } finally { console.warn = original; }
  return seen;
}

test('errno classification keeps "refused" apart from "absent"', () => {
  assert.deepEqual(checkCwd('/x/enoent', failing('ENOENT')), { ok: false, error: 'missing', code: 'ENOENT' });
  assert.deepEqual(checkCwd('/x/eperm', failing('EPERM')), { ok: false, error: 'denied', code: 'EPERM' });
  assert.deepEqual(checkCwd('/x/eacces', failing('EACCES')), { ok: false, error: 'denied', code: 'EACCES' });
  assert.deepEqual(checkCwd('/x/enotdir', failing('ENOTDIR')), { ok: false, error: 'not-a-directory', code: 'ENOTDIR' });
  assert.deepEqual(checkCwd('/x/eio', failing('EIO')), { ok: false, error: 'missing', code: 'EIO' });
});

test('a real directory is ok, a file is not-a-directory, a hole is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-project-cwd-'));
  try {
    const file = join(dir, 'file.txt');
    writeFileSync(file, 'x');
    assert.deepEqual(checkCwd(dir), { ok: true });
    assert.deepEqual(checkCwd(file), { ok: false, error: 'not-a-directory', code: 'NOT_A_DIRECTORY' });
    const hole = checkCwd(join(dir, 'nope'));
    assert.equal(hole.ok, false);
    assert.equal(hole.ok === false && hole.error, 'missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the log line names the path and the code, once per change', () => {
  const path = '/x/log-once';
  const lines = captureWarnings(() => {
    checkCwd(path, failing('EPERM'));
    checkCwd(path, failing('EPERM'));
    checkCwd(path, failing('EPERM'));
  });
  assert.deepEqual(lines, [`[projects] cwd ${path} → EPERM`]);

  const changed = captureWarnings(() => {
    checkCwd(path, failing('ENOENT'));
    checkCwd(path, failing('ENOENT'));
  });
  assert.deepEqual(changed, [`[projects] cwd ${path} → ENOENT`]);
});

test('a path that never failed is silent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-project-cwd-ok-'));
  try {
    assert.deepEqual(captureWarnings(() => { checkCwd(dir); checkCwd(dir); }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TODO #551: the git and files readers say why a cwd is unusable, a refusal is not "not found"', async () => {
  const { cwdProblem } = await import('./cwd-check.js');
  const { gitDashboard, gitLog, gitWorktrees } = await import('./git.js');
  captureWarnings(() => {
    assert.equal(cwdProblem('/x/eperm-git', failing('EPERM')), 'cwd access denied (EPERM)');
    assert.equal(cwdProblem('/x/eacces-git', failing('EACCES')), 'cwd access denied (EACCES)');
    assert.equal(cwdProblem('/x/enoent-git', failing('ENOENT')), 'cwd not found');
  });
  const dir = mkdtempSync(join(tmpdir(), 'timon-cwd-readers-'));
  try {
    const file = join(dir, 'plain.txt');
    writeFileSync(file, 'x');
    const missing = join(dir, 'gone');
    const silenced: Array<{ error?: string }> = [];
    const original = console.warn;
    console.warn = () => {};
    try {
      silenced.push(await gitDashboard(file), await gitLog(file, { limit: 1, skip: 0 }), await gitWorktrees(file));
      assert.deepEqual(silenced.map((r) => r.error), ['cwd is not a directory', 'cwd is not a directory', 'cwd is not a directory']);
      assert.equal((await gitDashboard(missing)).error, 'cwd not found');
      assert.equal((await gitDashboard(dir)).error, 'not a git repository');
    } finally { console.warn = original; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
