/**
 * TODO #636 — a task whose worktree was detached (TIM-0113) keeps its branch
 * with `worktree_path` NULL. The GC must still delete that branch once the
 * task is DONE and integrated, and never while a task that is not DONE still
 * names it (the 2026-09-20 trap: a fresh branch looks "merged" to git).
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { db, dbApi } from './db.js';
import { agentConfig, agentDir } from './paths.js';
import { createWorktree, releaseWorktreeFolder } from './worktree.js';
import { reconcileStaleWorktrees } from './worktree-gc.js';

const repo = join(process.env.TIMON_HOME!, `repo-${randomUUID()}`);
mkdirSync(repo, { recursive: true });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'user.email', 't@example.com');
git(repo, 'config', 'user.name', 'T');
writeFileSync(join(repo, 'a'), '1');
git(repo, 'add', 'a');
git(repo, 'commit', '-q', '-m', 'one');

// The GC finds a task's repo through its agent's cwd.
const agent = `gc-agent-${randomUUID().slice(0, 8)}`;
mkdirSync(agentDir(agent), { recursive: true });
writeFileSync(agentConfig(agent), JSON.stringify({ cwd: repo }));

const LONG_AGO = Date.now() - 24 * 3600_000;

const branchExists = (branch: string): boolean => {
  try { git(repo, 'rev-parse', '--verify', branch); return true; } catch { return false; }
};

/** A code task whose worktree held one commit, then was detached. */
async function detachedTask(opts: { commit?: boolean } = {}): Promise<{ id: string; branch: string; commit: string }> {
  const id = randomUUID();
  dbApi.createTask(id, 'feature', agent, { type: 'code' });
  const info = await createWorktree(id, repo, 'main');
  dbApi.setTaskWorktree(id, info.path, info.branch, info.base);
  if (opts.commit !== false) {
    writeFileSync(join(info.path, `f-${id}`), '2');
    git(info.path, 'add', '.');
    git(info.path, 'commit', '-q', '-m', 'work');
  }
  await releaseWorktreeFolder(info.path);
  dbApi.detachTaskWorktree(id);
  return { id, branch: info.branch, commit: git(repo, 'rev-parse', info.branch) };
}

function setState(id: string, status: string, sha: string | null): void {
  db.prepare('UPDATE tasks SET status = ?, merged_commit_sha = ?, updated_at = ? WHERE id = ?')
    .run(status, sha, LONG_AGO, id);
}

test('a DONE task merged outside Timon: its detached branch is deleted', async () => {
  const t = await detachedTask();
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', t.branch);
  setState(t.id, 'DONE', git(repo, 'rev-parse', 'HEAD'));

  await reconcileStaleWorktrees();

  assert.equal(branchExists(t.branch), false);
  assert.equal(dbApi.getTask(t.id)?.branch_name, null, 'no longer a candidate at the next pass');
});

test('a DONE task without sha but whose branch is in the base: deleted too', async () => {
  const t = await detachedTask();
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', t.branch);
  setState(t.id, 'DONE', null);

  await reconcileStaleWorktrees();

  assert.equal(branchExists(t.branch), false);
});

test('a DONE task whose branch is not integrated: the branch and its commit stay', async () => {
  const t = await detachedTask();
  setState(t.id, 'DONE', null);

  await reconcileStaleWorktrees();

  assert.equal(git(repo, 'rev-parse', t.branch), t.commit);
  assert.equal(dbApi.getTask(t.id)?.branch_name, t.branch);
});

for (const status of ['IN_PROGRESS', 'PENDING', 'BLOCKED']) {
  test(`a ${status} task: its detached branch is never touched, even without commits`, async () => {
    // No commit: git sees the branch as an ancestor of main, "merged".
    const t = await detachedTask({ commit: false });
    setState(t.id, status, null);

    await reconcileStaleWorktrees();

    assert.ok(branchExists(t.branch));
    assert.equal(dbApi.getTask(t.id)?.branch_name, t.branch);
  });
}

test('a DONE task whose branch is still named by a task that is not DONE: kept', async () => {
  const t = await detachedTask({ commit: false });
  setState(t.id, 'DONE', git(repo, 'rev-parse', 'main'));
  const live = randomUUID();
  dbApi.createTask(live, 'review', agent, { type: 'review' });
  db.prepare("UPDATE tasks SET branch_name = ?, status = 'IN_PROGRESS' WHERE id = ?").run(t.branch, live);

  await reconcileStaleWorktrees();

  assert.ok(branchExists(t.branch));
});

test('a task closed within the grace period: left alone for now', async () => {
  const t = await detachedTask();
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', t.branch);
  setState(t.id, 'DONE', git(repo, 'rev-parse', 'HEAD'));
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now(), t.id);

  await reconcileStaleWorktrees();

  assert.ok(branchExists(t.branch));
});
