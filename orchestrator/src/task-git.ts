/**
 * Where the Kanban meets the host's `git` (TODO #275).
 *
 * Decision B, pending the maintainer's confirmation: the board runs without git, and
 * only the tasks that work in a git repository need it. Without this check a
 * `code` task whose project IS a git repository, on a host without the
 * binary, found no repository, got no worktree, and its coder was spawned
 * straight into the shared checkout.
 *
 * A project that is not a git repository keeps its code → review pipeline
 * (no worktree, no merge) whether git is installed or not: the repository is
 * recognised on disk by its `.git` entry, which needs no binary. The entry is
 * looked for in the agent's directory AND its parents, as git itself does: an
 * agent working in `repo/app` is in a repository, and without git it would
 * otherwise be spawned in the shared checkout. A stray `.git` in a parent (an
 * empty folder in `/tmp`, a sentinel file) must not turn every project below
 * it into a repository, so the entry is checked the way git checks it.
 *
 * Option A (the whole Kanban needs git) is one line: move `git` from
 * `recommends` to `requires` on `@rooks/kanban` in `kernel/catalog.ts`. The
 * board then switches off with its dependents (triggers, routines,
 * todo-outcomes, kanban-code), and this check stays as a second line.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getHost } from './host/index.js';

/** Task types whose mission runs in, reviews or merges a git worktree. */
export const GIT_TASK_TYPES: readonly string[] = ['code', 'review', 'merge'];

export const GIT_MISSING_REASON =
  'git not found on this host: code, review and merge tasks of a git project need git. Install git, then restart Rooks.';

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Git's own test for a git directory, without the binary: a `HEAD` holding a
 * ref or an object id, plus `objects/` and `refs/` — in the directory itself,
 * or for a linked worktree in the shared directory its `commondir` names.
 */
export function isGitDirectory(dir: string): boolean {
  const head = readText(join(dir, 'HEAD'));
  if (head === null || !/^(?:ref: refs\/|[0-9a-f]{40})/.test(head)) return false;
  const commondir = readText(join(dir, 'commondir'));
  const common = commondir === null ? dir : resolve(dir, commondir.trim());
  return isDirectory(join(common, 'objects')) && isDirectory(join(common, 'refs'));
}

/**
 * The git directory a `.git` entry stands for, `null` when it stands for none:
 * the folder itself for a checkout, the `gitdir:` target of a file for a
 * worktree or a submodule (relative to the file, as git resolves it).
 */
function gitDirectoryOf(entry: string): string | null {
  if (isDirectory(entry)) return isGitDirectory(entry) ? entry : null;
  const match = /^gitdir: *(.+?)\s*$/.exec(readText(entry) ?? '');
  if (!match?.[1]) return null;
  const target = resolve(dirname(entry), match[1]);
  return isGitDirectory(target) ? target : null;
}

/**
 * Whether `cwd` lies inside a git repository, read off the disk without the
 * binary: a valid `.git` entry from `cwd` up to the filesystem root. An
 * invalid one is skipped, as git skips a folder that is not a git directory.
 */
export function insideGitRepository(cwd: string): boolean {
  let dir = resolve(cwd);
  for (;;) {
    if (gitDirectoryOf(join(dir, '.git')) !== null) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Why a task of this type cannot run here, `null` when it can. `cwd` is the
 * assigned agent's working directory: a `merge` always needs git, a `code` or
 * `review` only when that directory is inside a git repository
 * (`insideGitRepository`).
 */
export function gitTaskRefusal(
  type: string | null | undefined,
  opts: { cwd?: string | null; capabilities?: readonly string[] } = {},
): string | null {
  if (!type || !GIT_TASK_TYPES.includes(type)) return null;
  const capabilities = opts.capabilities ?? getHost().capabilities();
  if (capabilities.includes('git')) return null;
  if (type !== 'merge' && !(opts.cwd && insideGitRepository(opts.cwd))) return null;
  return GIT_MISSING_REASON;
}

/** Acceptable shape for a worktree base. Not an existence check:
 *  just what keeps a string from being read as a flag or a relative path
 *  by git. */
export function isPlausibleGitRef(ref: string): boolean {
  if (ref.length === 0 || ref.length > 255) return false;
  if (ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/')) return false;
  if (ref.includes('..') || ref.endsWith('.lock')) return false;
  return /^[A-Za-z0-9._/-]+$/.test(ref);
}
