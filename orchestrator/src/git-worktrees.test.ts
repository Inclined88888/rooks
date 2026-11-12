/**
 * `parseWorktreePorcelain` (git.ts) on the states a throwaway repository does
 * not produce easily: bare, detached, locked, prunable, a nested cwd. And the
 * dashboard, on a real one, which reads its worktrees through the same parser.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { gitDashboard, parseWorktreePorcelain } from './git.js';

const NUL = '\0';
const block = (...fields: string[]): string => fields.map((f) => f + NUL).join('') + NUL;
const root = join(normalize('/'), 'repos', 'proj');

test('bare, detached, locked and prunable entries are read field by field', () => {
  const raw = block(`worktree ${root}`, 'bare')
    + block(`worktree ${join(root, 'wt-a')}`, 'HEAD aaaa', 'detached', 'locked', 'prunable gitdir file points to non-existent location')
    + block(`worktree ${join(root, 'wt-b')}`, 'HEAD bbbb', 'branch refs/heads/feat/x', 'locked on a usb drive');
  const [bare, a, b] = parseWorktreePorcelain(raw, join(root, 'elsewhere-not-a-worktree'));
  assert.deepEqual(bare, {
    path: root, head: null, branch: null, main: true, current: true,
    bare: true, detached: false, locked: null, prunable: null,
  });
  assert.equal(a?.detached, true);
  assert.equal(a?.branch, null);
  assert.equal(a?.locked, '');
  assert.equal(a?.prunable, 'gitdir file points to non-existent location');
  assert.equal(b?.branch, 'feat/x');
  assert.equal(b?.locked, 'on a usb drive');
  assert.equal(b?.main, false);
});

test('a cwd inside a nested worktree marks only that worktree current', () => {
  const nested = join(root, '.worktrees', 'task');
  const raw = block(`worktree ${root}`, 'HEAD 1111', 'branch refs/heads/main')
    + block(`worktree ${nested}`, 'HEAD 2222', 'branch refs/heads/task');
  const list = parseWorktreePorcelain(raw, join(nested, 'src'));
  assert.deepEqual(list.map((w) => w.current), [false, true]);
  // A sibling whose name extends the worktree's is not inside it.
  const sibling = parseWorktreePorcelain(raw, `${nested}-other`);
  assert.deepEqual(sibling.map((w) => w.current), [true, false]);
});

test('a path with a newline stays whole under -z', () => {
  const odd = join(root, 'line\nbreak');
  const list = parseWorktreePorcelain(block(`worktree ${odd}`, 'HEAD 3333', 'branch refs/heads/main'), root);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.path, odd);
});

test('the dashboard flags a branch held by a linked worktree, and only that one', async () => {
  const base = mkdtempSync(join(tmpdir(), 'rooks-git-dashboard-'));
  const repo = join(base, 'repo');
  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: base,
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
  };
  try {
    git('init', '-q', '-b', 'main', repo);
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    git('-C', repo, 'add', '-A');
    git('-C', repo, 'commit', '-qm', 'base');
    git('-C', repo, 'branch', 'idle');
    git('-C', repo, 'worktree', 'add', '-q', '-b', 'feat/held', join(base, 'held'));
    const dash = await gitDashboard(repo);
    assert.equal(dash.ok, true);
    const flags = Object.fromEntries(dash.branches.map((b) => [b.name, b.worktree]));
    assert.deepEqual(flags, { main: false, idle: false, 'feat/held': true });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
