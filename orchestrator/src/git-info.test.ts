/**
 * `gitInfo` (git.ts): the lines added and removed that the composer's Git bar
 * shows beside the branch. A real throwaway repository for the sum, the
 * parser alone for what one does not produce easily (binary, odd lines), and
 * whether the agent's repository is its project's (`foreignRepo`, TODO #429).
 */
import './test-home.js';
import { mock, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitNoAnswerError, gitDashboard, gitInfo, gitLog, gitWorktrees, parseNumstat } from './git.js';
import { getHost } from './host/index.js';
import type { ExecOpts } from './host/types.js';
import { agentConfig, agentDir } from './paths.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

// What these tests read is the repository, not the clock: without its timeout
// real git keeps its answer on a machine where it takes 10 s to start (TODO #657).
const realExec = getHost().execAsync;
const withoutClock = (name: string, args: string[], opts?: ExecOpts) => realExec(name, args, { ...opts, timeout: 0 });
mock.method(getHost(), 'execAsync', withoutClock);

/** The reads `stopped` picks time out; the others go to real git. */
function timeOut(t: TestContext, stopped: (args: string[]) => boolean): void {
  t.mock.method(getHost(), 'execAsync', async (name: string, args: string[], opts?: ExecOpts) => (
    stopped(args) ? { code: 1, stdout: '', stderr: '', timedOut: true } : withoutClock(name, args, opts)
  ));
}

function repoWithCommit(root: string, name: string): string {
  const repo = join(root, name);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'witness@example.invalid');
  git(repo, 'config', 'user.name', 'witness');
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

function agentOn(name: string, cwd: string): void {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(agentConfig(name), JSON.stringify({ name, cwd }));
}

test('binary files and stray lines add nothing to the sum', () => {
  const raw = '3\t1\tsrc/a.ts\n-\t-\tlogo.png\n10\t0\tdocs/b.md\nwarning: something\n';
  assert.deepEqual(parseNumstat(raw), { added: 13, removed: 1 });
  assert.deepEqual(parseNumstat(''), { added: 0, removed: 0 });
});

test('staged and unstaged changes are both counted, untracked files are not', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'timon-git-info-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'witness@example.invalid');
  git(repo, 'config', 'user.name', 'witness');
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  agentOn('numstat-agent', repo);

  assert.deepEqual(await gitInfo('numstat-agent'), {
    branch: 'main', dirty: false, worktree: null, added: 0, removed: 0,
  });

  writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n');
  writeFileSync(join(repo, 'b.txt'), 'staged\n');
  git(repo, 'add', 'b.txt');
  writeFileSync(join(repo, 'untracked.txt'), 'never counted\n');
  const info = await gitInfo('numstat-agent');
  assert.equal(info.dirty, true);
  // a.txt: TWO replaces two (+1 −1), four is new (+1); b.txt staged (+1).
  assert.equal(info.added, 3);
  assert.equal(info.removed, 1);
});

test('a repository without a commit yet reads as nothing changed', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'timon-git-info-empty-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  agentOn('fresh-agent', repo);
  const info = await gitInfo('fresh-agent');
  assert.equal(info.added, 0);
  assert.equal(info.removed, 0);
});

test('foreignRepo: another repository is foreign, a linked worktree or a subfolder of the project is not', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'timon-git-info-foreign-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = repoWithCommit(root, 'project');
  const other = repoWithCommit(root, 'other');
  const linked = join(root, 'linked');
  git(project, 'worktree', 'add', '-q', '-b', 'side', linked);
  mkdirSync(join(project, 'sub'));
  // The project read through a symlink: the same repository, another spelling.
  // Windows refuses a symlink without the privilege: a junction says the same.
  const alias = join(root, 'alias');
  symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir');

  agentOn('foreign-agent', other);
  agentOn('linked-agent', linked);
  agentOn('sub-agent', join(project, 'sub'));
  agentOn('main-agent', project);

  assert.equal((await gitInfo('foreign-agent', project)).foreignRepo, true);
  assert.equal((await gitInfo('linked-agent', project)).foreignRepo, false);
  assert.equal((await gitInfo('sub-agent', project)).foreignRepo, false);
  assert.equal((await gitInfo('main-agent', alias)).foreignRepo, false);
  // From the project's own linked worktree, its main checkout is the same repository.
  assert.equal((await gitInfo('main-agent', linked)).foreignRepo, false);
  // A project without a folder, or whose folder is no repository, holds none of the agent's branches.
  assert.equal((await gitInfo('main-agent', null)).foreignRepo, true);
  mkdirSync(join(root, 'plain'));
  assert.equal((await gitInfo('main-agent', join(root, 'plain'))).foreignRepo, true);
  // Asked without a project: the field is absent, as from an older daemon.
  assert.equal('foreignRepo' in (await gitInfo('foreign-agent')), false);
});

// TODO #657: a read that timed out came back as "no repository", or as
// `foreignRepo: true` (the picker then blocks every branch). Under a loaded
// machine that is a false statement, not a missing detail. One pair of
// repositories for these tests: they only read, and each git costs a process.
const shared = mkdtempSync(join(tmpdir(), 'timon-git-info-silent-'));
test.after(() => rmSync(shared, { recursive: true, force: true }));
const project = repoWithCommit(shared, 'project');
const other = repoWithCommit(shared, 'other');
agentOn('silent-agent', other);
agentOn('project-agent', project);

test('a git that does not answer says nothing about the repository', async (t) => {
  const reads: [string, (args: string[]) => boolean][] = [
    ['in a work tree', (a) => a.includes('--is-inside-work-tree')],
    ['the branch', (a) => a.includes('--show-current')],
    ['the git dir', (a) => a.includes('--git-dir')],
    ["the agent's common dir", (a) => a[1] === other && a.includes('--git-common-dir')],
    ["the project's common dir", (a) => a[1] === project && a.includes('--git-common-dir')],
  ];
  for (const [what, stopped] of reads) {
    await t.test(what, async (st) => {
      timeOut(st, stopped);
      await assert.rejects(gitInfo('silent-agent', project), GitNoAnswerError);
    });
  }
  assert.equal((await gitInfo('silent-agent', project)).foreignRepo, true, 'the same repositories, git answering');
});

test('a status or a diff too slow for a big repository still leaves its branch', async (t) => {
  timeOut(t, (a) => a.includes('status') || a.includes('diff'));
  const info = await gitInfo('project-agent', project);
  assert.equal(info.branch, 'main');
  assert.equal(info.foreignRepo, false);
  assert.equal(info.added, 0);
});

test('the other git reads do not call a silent repository "not a git repository"', async (t) => {
  mkdirSync(join(shared, 'plain'));
  const reads = [gitDashboard, gitWorktrees, (cwd: string) => gitLog(cwd, { limit: 1, skip: 0 })];
  for (const read of reads) assert.equal((await read(join(shared, 'plain'))).error, 'not a git repository');
  timeOut(t, (a) => a.includes('--is-inside-work-tree'));
  for (const read of reads) {
    const out = await read(project);
    assert.equal(out.ok, false);
    assert.match(out.error ?? '', /did not answer/);
  }
});

test('a read gets more than a blink: 1.5 s told a busy machine it had no repository', async (t) => {
  const budgets: number[] = [];
  t.mock.method(getHost(), 'execAsync', (name: string, args: string[], opts?: ExecOpts) => {
    budgets.push(Number(opts?.timeout));
    return withoutClock(name, args, opts);
  });
  await gitInfo('project-agent', project);
  assert.equal(budgets.length, 7);
  for (const ms of budgets) assert.ok(ms >= 5000, `a git read has ${ms} ms`);
});
