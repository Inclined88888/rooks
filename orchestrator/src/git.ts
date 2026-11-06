/**
 * Lightweight git introspection scoped to an agent's working dir.
 * Used by the chat statusline to surface the branch / worktree the
 * agent is sitting in, mirroring what the Claude Code CLI shows.
 *
 * Best-effort: returns nulls when the cwd isn't a git repo, when git
 * isn't installed in the container, or when any individual command
 * fails — the statusline tolerates missing fields gracefully.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { checkCwd, cwdProblem } from './cwd-check.js';
import { join, normalize, resolve, sep } from 'node:path';
import { agentDir } from './paths.js';
import { execFileHost } from './host/index.js';

const exec = execFileHost;

export type GitInfo = {
  /** Current branch name, or null when detached / unavailable. */
  branch: string | null;
  /** True when working tree has any modifications. */
  dirty: boolean;
  /** When inside a git worktree, the worktree name (last path segment
   *  of the worktree directory); null for the main checkout. */
  worktree: string | null;
  /** Lines added / removed in tracked files against HEAD, staged or not.
   *  Untracked files are not counted: git has no diff for them yet. */
  added: number;
  removed: number;
  /** Only when asked for a project: the cwd is a repository other than the
   *  project's (neither its checkout nor one of its worktrees), so the
   *  project's branches are not the ones the agent works on. */
  foreignRepo?: boolean;
};

async function loadAgentCwd(agentName: string): Promise<string | null> {
  const cfgPath = join(agentDir(agentName), 'config.json');
  if (!existsSync(cfgPath)) return null;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { cwd?: string };
    if (!cfg.cwd || !checkCwd(cfg.cwd).ok) return null;
    return cfg.cwd;
  } catch {
    return null;
  }
}

/** A loaded machine (or Windows with its antivirus) can take seconds to start
 *  even a `rev-parse`: 1.5 s told a busy machine it had no repository. */
const GIT_READ_TIMEOUT_MS = 5000;

/** Git did not answer in time: nothing is known of the repository, which is
 *  not the same as git saying there is none. */
export class GitNoAnswerError extends Error {
  constructor(cwd: string) {
    super(`git did not answer in ${cwd}`);
    this.name = 'GitNoAnswerError';
  }
}

/** A read whose failure the caller takes as a fact ("no repository", "another
 *  repository"): only git's own refusal gives null. */
async function gitFact(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-C', cwd, ...args], { timeout: GIT_READ_TIMEOUT_MS });
    return stdout.trim();
  } catch (error) {
    if ((error as { timedOut?: boolean }).timedOut) throw new GitNoAnswerError(cwd);
    return null;
  }
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await gitFact(cwd, args);
  } catch {
    return null;
  }
}

/**
 * `projectCwd` (the project's folder, null when it has none) asks whether the
 * agent's repository is the project's: both `--git-common-dir` resolve to the
 * same directory for the main checkout, a linked worktree or a subfolder of
 * either. Compared through `canonical()`, never as typed: a symlinked folder,
 * macOS `/private/var` or a Windows drive letter in another case would
 * otherwise read as another repository.
 *
 * Rejects with `GitNoAnswerError` when a read that decides what the repository
 * IS times out: answering would state a guess as a fact, and the client keeps
 * its last known state on a failed read. `status` and `diff` stay best-effort,
 * their cost grows with the repository: one too big for them still has a branch.
 */
export async function gitInfo(agentName: string, projectCwd?: string | null): Promise<GitInfo> {
  const empty: GitInfo = { branch: null, dirty: false, worktree: null, added: 0, removed: 0 };
  const cwd = await loadAgentCwd(agentName);
  if (!cwd) return empty;
  // `--show-current` is empty in detached HEAD; that's fine.
  // Independent reads, run in parallel. `rev-parse --is-inside-work-tree`
  // returns 'true' iff git understands this dir — otherwise the other results
  // are meaningless and we bail.
  // Worktree detection: `git rev-parse --git-common-dir` differs from
  // `--git-dir` only inside a linked worktree. When they match, we're
  // on the main checkout — no worktree label to surface.
  // `--numstat` rather than `--shortstat`: the summary line is translated
  // by git's locale, the per-file counts are not. No HEAD yet (fresh repo):
  // the read fails and counts as nothing changed.
  const [branch, status, inRepo, gitDir, commonDir, numstat, projectCommonDir] = await Promise.all([
    gitFact(cwd, ['branch', '--show-current']),
    git(cwd, ['status', '--porcelain']),
    gitFact(cwd, ['rev-parse', '--is-inside-work-tree']),
    gitFact(cwd, ['rev-parse', '--git-dir']),
    gitFact(cwd, ['rev-parse', '--git-common-dir']),
    gitSlow(cwd, ['diff', '--numstat', '--no-ext-diff', 'HEAD']),
    projectCwd && checkCwd(projectCwd).ok ? gitFact(projectCwd, ['rev-parse', '--git-common-dir']) : Promise.resolve(null),
  ]);
  if (inRepo !== 'true') return empty;

  let worktree: string | null = null;
  if (gitDir && commonDir && gitDir !== commonDir) {
    // gitDir like '/path/repo/.git/worktrees/<name>' — last segment is
    // the worktree name.
    const segs = gitDir.split('/');
    worktree = segs[segs.length - 1] || null;
  }

  const info: GitInfo = {
    branch: branch || null,
    dirty: !!status,
    worktree,
    ...parseNumstat(numstat ?? ''),
  };
  if (projectCwd !== undefined) {
    // `--git-common-dir` may be relative to the folder it was asked from.
    // A project with no folder or no repository has no branch of the agent's
    // either: the agent is elsewhere.
    info.foreignRepo = !commonDir || !projectCommonDir || !projectCwd
      || canonical(resolve(cwd, commonDir)) !== canonical(resolve(projectCwd, projectCommonDir));
  }
  return info;
}

/** Sums `git diff --numstat`: `added<TAB>removed<TAB>path` per file, `-`
 *  for both counts on a binary file, which adds no line. */
export function parseNumstat(raw: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of raw.split('\n')) {
    const m = /^(\d+)\t(\d+)\t/.exec(line);
    if (!m) continue;
    added += Number(m[1]);
    removed += Number(m[2]);
  }
  return { added, removed };
}

/* ────────────────────────────────────────────────────────────────────────────
   Git dashboard — rich view of a repo (branches, working tree, ahead/behind)
   for the GIT tab of the UI. Scoped to a project's `cwd` (absolute host path).
   Runs on the orchestrator side (host mode) because the app container has no access
   to the host repos — only the orchestrator sees `~/webdev/projects/<slug>`.
   ──────────────────────────────────────────────────────────────────────────── */

export type GitBranch = {
  name: string;
  /** Branch currently checked out in the main worktree. */
  current: boolean;
  /** Already merged into the base (main/master). */
  merged: boolean;
  /** Commits ahead of the base. */
  ahead: number;
  /** Commits behind the base. */
  behind: number;
  /** Timestamp (ms epoch) of the branch's last commit. */
  lastCommitTs: number;
  /** Subject (1st line) of the last commit. */
  lastCommitSubject: string;
  /** Branch occupied by a linked worktree → neither switch nor delete possible. */
  worktree: boolean;
};

export type GitDashboard = {
  ok: boolean;
  /** Inspected working dir (project cwd). */
  repo: string | null;
  /** Detected base branch (main, otherwise master, otherwise current). */
  base: string | null;
  currentBranch: string | null;
  branches: GitBranch[];
  /** Files with indexed (staged) changes. */
  staged: string[];
  /** Modified files not indexed (unstaged, tracked). */
  unstaged: string[];
  /** Untracked files. */
  untracked: string[];
  error?: string;
};

/** Guard against option injection: a branch name must not
 *  start with `-` (otherwise read as a git flag) nor contain `..`
 *  or spaces. execFile already passes the args without a shell, this covers
 *  the residual option injection. */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
export function validBranchName(name: string): boolean {
  return BRANCH_RE.test(name) && !name.includes('..');
}

/** `git()` for a long output (rev-list/for-each-ref on a big repository): a
 *  larger buffer, leading whitespace kept. Null on failure. */
async function gitSlow(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-C', cwd, ...args], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    return stdout.replace(/\n$/, '');
  } catch {
    return null;
  }
}

/** Detects the base branch: `main` if it exists, otherwise `master`,
 *  otherwise the current branch. */
function detectBase(localBranches: string[], current: string | null): string | null {
  if (localBranches.includes('main')) return 'main';
  if (localBranches.includes('master')) return 'master';
  return current;
}

/** List of the branches occupied by a linked worktree (outside the main checkout).
 *  These branches can be neither switched to nor deleted. The main worktree
 *  is listed too; the caller tells it apart through `current`. */
async function worktreeBranches(cwd: string): Promise<Set<string>> {
  const raw = await gitSlow(cwd, ['worktree', 'list', '--porcelain', '-z']);
  if (!raw) return new Set();
  return new Set(parseWorktreePorcelain(raw, cwd).flatMap((w) => (w.branch ? [w.branch] : [])));
}

/** The error of a read that needs a repository, null when `cwd` is one. */
async function notARepository(cwd: string): Promise<string | null> {
  try {
    return (await gitFact(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true' ? null : 'not a git repository';
  } catch (error) {
    return (error as Error).message;
  }
}

export async function gitDashboard(cwd: string): Promise<GitDashboard> {
  const empty: GitDashboard = {
    ok: false, repo: cwd, base: null, currentBranch: null,
    branches: [], staged: [], unstaged: [], untracked: [],
  };
  const problem = cwd ? cwdProblem(cwd) : 'cwd not found';
  if (problem) return { ...empty, error: problem };

  const notRepo = await notARepository(cwd);
  if (notRepo) return { ...empty, error: notRepo };

  const current = (await git(cwd, ['branch', '--show-current'])) || null;

  // ── Working tree (porcelain v1) ──
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const status = await git(cwd, ['status', '--porcelain']);
  if (status) {
    for (const line of status.split('\n')) {
      if (!line) continue;
      const x = line[0];
      const y = line[1];
      const path = line.slice(3);
      if (x === '?' && y === '?') { untracked.push(path); continue; }
      if (x !== ' ' && x !== '?') staged.push(path);
      if (y !== ' ' && y !== '?') unstaged.push(path);
    }
  }

  // ── Local branches ──
  // Format delimited by \x1f (unit separator) to tolerate `|` in the subjects.
  const refs = await gitSlow(cwd, [
    'for-each-ref',
    '--format=%(refname:short)\x1f%(committerdate:unix)\x1f%(contents:subject)',
    'refs/heads',
  ]);
  const names: string[] = [];
  const rows: { name: string; ts: number; subject: string }[] = [];
  if (refs) {
    for (const line of refs.split('\n')) {
      if (!line) continue;
      const [name, unix, ...rest] = line.split('\x1f');
      if (!name) continue;
      names.push(name);
      rows.push({ name, ts: (Number(unix) || 0) * 1000, subject: rest.join('\x1f') || '' });
    }
  }

  const base = detectBase(names, current);
  const occupied = await worktreeBranches(cwd);

  // Branches merged into the base (list of names).
  const mergedSet = new Set<string>();
  if (base) {
    const merged = await gitSlow(cwd, ['branch', '--merged', base, '--format=%(refname:short)']);
    if (merged) for (const n of merged.split('\n')) if (n) mergedSet.add(n.trim());
  }

  const branches: GitBranch[] = await Promise.all(rows.map(async (r) => {
    let ahead = 0;
    let behind = 0;
    if (base && r.name !== base) {
      // rev-list --left-right --count base...branch → "behind\tahead"
      const counts = await gitSlow(cwd, ['rev-list', '--left-right', '--count', `${base}...${r.name}`]);
      if (counts) {
        const [b, a] = counts.split(/\s+/).map((v) => Number(v) || 0);
        behind = b || 0;
        ahead = a || 0;
      }
    }
    return {
      name: r.name,
      current: r.name === current,
      merged: mergedSet.has(r.name),
      ahead,
      behind,
      lastCommitTs: r.ts,
      lastCommitSubject: r.subject,
      worktree: occupied.has(r.name) && r.name !== current,
    };
  }));

  // Sort: current first, then by descending commit date.
  branches.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return b.lastCommitTs - a.lastCommitTs;
  });

  return {
    ok: true,
    repo: cwd,
    base,
    currentBranch: current,
    branches,
    staged,
    unstaged,
    untracked,
  };
}

/** One entry of `git worktree list`. */
export type GitWorktree = {
  /** Absolute path, normalised for the host OS (git prints `C:/…` on Windows). */
  path: string;
  /** Full sha of the checked-out commit; null for a bare repository. */
  head: string | null;
  /** Short branch name (`refs/heads/` stripped); null when detached or bare. */
  branch: string | null;
  /** The first entry: the repository's own checkout, not a linked worktree. */
  main: boolean;
  /** The worktree the project's cwd sits in. */
  current: boolean;
  bare: boolean;
  detached: boolean;
  /** `locked` given, with its reason when there is one (empty string otherwise). */
  locked: string | null;
  /** The directory is gone: `git worktree prune` would drop the entry. */
  prunable: string | null;
};

export type GitWorktreeList = {
  ok: boolean;
  repo: string | null;
  worktrees: GitWorktree[];
  error?: string;
};

/** Comparison key of a path: realpath when it resolves (a symlinked tmpdir,
 *  macOS `/var` → `/private/var`, must not break the comparison), lowercased
 *  on Windows where git prints `C:/…` and the project meta may hold `c:\…`. */
function canonical(p: string): string {
  let real: string;
  try { real = realpathSync.native(p); } catch { real = normalize(p); }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** Parses `git worktree list --porcelain -z`: attributes are NUL-terminated,
 *  an empty attribute ends a block. `-z` keeps a path with a newline whole. */
export function parseWorktreePorcelain(raw: string, cwd: string): GitWorktree[] {
  const here = canonical(cwd);
  const out: GitWorktree[] = [];
  let cur: GitWorktree | null = null;
  const flush = () => { if (cur) out.push(cur); cur = null; };
  for (const field of raw.split('\0')) {
    if (field === '') { flush(); continue; }
    const sp = field.indexOf(' ');
    const key = sp === -1 ? field : field.slice(0, sp);
    const value = sp === -1 ? '' : field.slice(sp + 1);
    if (key === 'worktree') {
      flush();
      const path = normalize(value);
      cur = {
        path, head: null, branch: null, main: out.length === 0, current: false,
        bare: false, detached: false, locked: null, prunable: null,
      };
      const real = canonical(path);
      cur.current = here === real || here.startsWith(real.endsWith(sep) ? real : real + sep);
      continue;
    }
    if (!cur) continue;
    const w: GitWorktree = cur;
    if (key === 'HEAD') w.head = value || null;
    else if (key === 'branch') w.branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
    else if (key === 'bare') w.bare = true;
    else if (key === 'detached') w.detached = true;
    else if (key === 'locked') w.locked = value;
    else if (key === 'prunable') w.prunable = value;
  }
  flush();
  // A cwd inside a nested worktree also sits under the main checkout: only
  // the deepest match is current.
  const matches = out.filter((w) => w.current);
  if (matches.length > 1) {
    const deepest = matches.reduce((a, b) => (canonical(b.path).length > canonical(a.path).length ? b : a));
    for (const w of matches) w.current = w === deepest;
  }
  return out;
}

export async function gitWorktrees(cwd: string): Promise<GitWorktreeList> {
  const empty: GitWorktreeList = { ok: false, repo: cwd, worktrees: [] };
  const problem = cwd ? cwdProblem(cwd) : 'cwd not found';
  if (problem) return { ...empty, error: problem };
  const notRepo = await notARepository(cwd);
  if (notRepo) return { ...empty, error: notRepo };
  const raw = await gitSlow(cwd, ['worktree', 'list', '--porcelain', '-z']);
  if (raw === null) return { ...empty, error: 'git worktree list failed' };
  return { ok: true, repo: cwd, worktrees: parseWorktreePorcelain(raw, cwd) };
}

/** A ref decorating a commit. `head` is HEAD itself (attached or detached). */
export type GitRef = { kind: 'head' | 'branch' | 'remote' | 'tag'; name: string };

export type GitCommit = {
  hash: string;
  short: string;
  /** Full shas, first parent first. A parent may be outside the page returned. */
  parents: string[];
  author: string;
  /** Author date, ms epoch (same unit as `GitBranch.lastCommitTs`). */
  ts: number;
  subject: string;
  refs: GitRef[];
};

export type GitLog = {
  ok: boolean;
  repo: string | null;
  /** Full sha of HEAD; null in a repository without commits. */
  head: string | null;
  currentBranch: string | null;
  /** More commits exist past this page (ask again with `skip`). */
  truncated: boolean;
  commits: GitCommit[];
  error?: string;
};

export const GIT_LOG_MAX = 500;

/** `%D` under `--decorate=full`: `HEAD -> refs/heads/main, tag: refs/tags/v1, …`.
 *  A remote's symbolic `HEAD` only repeats its default branch: dropped. */
function parseDecorations(raw: string): GitRef[] {
  const refs: GitRef[] = [];
  for (let part of raw.split(', ')) {
    if (!part) continue;
    if (part === 'HEAD') { refs.push({ kind: 'head', name: 'HEAD' }); continue; }
    if (part.startsWith('HEAD -> ')) { refs.push({ kind: 'head', name: 'HEAD' }); part = part.slice('HEAD -> '.length); }
    if (part.startsWith('tag: refs/tags/')) refs.push({ kind: 'tag', name: part.slice('tag: refs/tags/'.length) });
    else if (part.startsWith('refs/heads/')) refs.push({ kind: 'branch', name: part.slice('refs/heads/'.length) });
    else if (part.startsWith('refs/remotes/') && !part.endsWith('/HEAD')) {
      refs.push({ kind: 'remote', name: part.slice('refs/remotes/'.length) });
    }
  }
  return refs;
}

/** Parses `git log -z --format=%H%x1f%h%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s`. */
export function parseGitLog(raw: string): GitCommit[] {
  const out: GitCommit[] = [];
  for (const record of raw.split('\0')) {
    const fields = record.replace(/^\n/, '').split('\x1f');
    const [hash, short, parents, author, at, decorations, ...subject] = fields;
    if (!hash || !short) continue;
    out.push({
      hash,
      short,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      author: author ?? '',
      ts: (Number(at) || 0) * 1000,
      subject: subject.join('\x1f'),
      refs: parseDecorations(decorations ?? ''),
    });
  }
  return out;
}

/** The commits of every local branch, remote branch and tag (plus HEAD when
 *  detached), newest first, children always before their parents, bounded by
 *  `limit`. `--all` is avoided on purpose: it drags the stash and notes in. */
export async function gitLog(cwd: string, opts: { limit: number; skip: number }): Promise<GitLog> {
  const empty: GitLog = { ok: false, repo: cwd, head: null, currentBranch: null, truncated: false, commits: [] };
  const problem = cwd ? cwdProblem(cwd) : 'cwd not found';
  if (problem) return { ...empty, error: problem };
  const notRepo = await notARepository(cwd);
  if (notRepo) return { ...empty, error: notRepo };
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit)), GIT_LOG_MAX);
  const skip = Math.max(0, Math.trunc(opts.skip));
  const [head, current] = await Promise.all([
    git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']),
    git(cwd, ['branch', '--show-current']),
  ]);
  const raw = await gitSlow(cwd, [
    // A user's `log.showSignature` would put gpg output in stdout.
    'log', '--no-color', '--no-show-signature', '--decorate=full', '--date-order', '-z',
    `--max-count=${limit + 1}`, `--skip=${skip}`,
    '--format=%H%x1f%h%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s',
    // Without commits HEAD does not resolve: naming it would fail the whole log.
    ...(head ? ['HEAD'] : []), '--branches', '--remotes', '--tags', '--',
  ]);
  if (raw === null) return { ...empty, head: head || null, currentBranch: current || null, error: 'git log failed' };
  const commits = parseGitLog(raw);
  return {
    ok: true,
    repo: cwd,
    head: head || null,
    currentBranch: current || null,
    truncated: commits.length > limit,
    commits: commits.slice(0, limit),
  };
}

/** Branch switch in the repo's main worktree. Fails (returns the
 *  git message) if the branch is occupied by a worktree, missing,
 *  or if the working tree prevents the checkout. */
export async function gitCheckout(cwd: string, branch: string): Promise<{ ok: boolean; error?: string }> {
  if (!validBranchName(branch)) return { ok: false, error: 'invalid branch name' };
  const problem = cwdProblem(cwd);
  if (problem) return { ok: false, error: problem };
  try {
    await exec('git', ['-C', cwd, 'checkout', branch], { timeout: 10000 });
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, error: (e.stderr || e.message || 'checkout failed').trim() };
  }
}

/** Deletes a local branch. Refuses the current branch. Uses `-d`
 *  (safe) by default: git refuses to delete an unmerged branch, which
 *  protects against losing commits. `force` → `-D`. */
export async function gitDeleteBranch(
  cwd: string,
  branch: string,
  force = false,
): Promise<{ ok: boolean; error?: string }> {
  if (!validBranchName(branch)) return { ok: false, error: 'invalid branch name' };
  const problem = cwdProblem(cwd);
  if (problem) return { ok: false, error: problem };
  const current = await git(cwd, ['branch', '--show-current']);
  if (current === branch) return { ok: false, error: 'cannot delete the current branch' };
  try {
    await exec('git', ['-C', cwd, 'branch', force ? '-D' : '-d', branch], { timeout: 10000 });
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, error: (e.stderr || e.message || 'deletion failed').trim() };
  }
}
