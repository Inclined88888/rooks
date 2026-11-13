/**
 * What the composer's branch picker lists, read from the shared Git store
 * (`lib/git-store.ts`) and nothing else: the project checkout's branches,
 * the repository's worktrees, and the agent's own folder.
 *
 * The checkout route moves the PROJECT checkout. When the conversation's
 * agent works in a linked worktree, that is another folder than the one its
 * bar shows: switching from the picker would move a branch the user is not
 * looking at, so every row is then read-only. Same when its folder is another
 * repository altogether (`foreignRepo`, decided by the daemon after realpath):
 * the project's branches are then not even the agent's.
 */

import { pathTail } from '@/lib/git-graph';
import type { AgentGitInfo, GitDashboard, GitWorktreeList } from '@/lib/git-store';

/** Why a branch row cannot be switched to; null = it can. */
export type BlockReason = 'current' | 'worktree' | 'elsewhere' | null;

export type PickerBranch = {
  name: string;
  /** Checked out in the project checkout. */
  current: boolean;
  /** The branch the conversation's folder is on. */
  here: boolean;
  worktree: boolean;
  ahead: number;
  behind: number;
  subject: string;
  blocked: BlockReason;
};

export type PickerWorktree = {
  path: string;
  name: string;
  branch: string | null;
  detached: boolean;
  main: boolean;
  /** The conversation's folder. */
  here: boolean;
  locked: boolean;
  prunable: boolean;
};

export type PickerModel = {
  /** Null while the project checkout has not been read yet. */
  branches: PickerBranch[] | null;
  /** Null while the worktree list has not been read yet. */
  worktrees: PickerWorktree[] | null;
  /** The agent works in a linked worktree (named by its folder): nothing
   *  is switchable here. */
  inWorktree: string | null;
  /** The agent works in another repository than the project's (named by its
   *  folder): nothing is switchable, and nothing here is the agent's. */
  inOtherRepo: string | null;
  /** Changes of the project checkout, asked about before a checkout. */
  changes: number;
};

export function pickerModel(
  dash: GitDashboard | null,
  list: GitWorktreeList | null,
  agent: AgentGitInfo | null,
  cwd: string | null | undefined,
): PickerModel {
  const holder = list?.ok && cwd ? holderOf(list.worktrees.map((w) => w.path), cwd) : null;
  const foreign = agent?.foreignRepo === true;
  const inOtherRepo = foreign ? folderOf(agent, cwd) ?? '' : null;
  const inWorktree = !foreign && agent?.worktree ? (holder ? pathTail(holder) : folderOf(agent, cwd)) : null;
  const branches = dash?.ok
    ? dash.branches.map((b): PickerBranch => ({
        name: b.name,
        current: b.current,
        // The agent's branch names another repository's: a `main` there is
        // not the project's `main`.
        here: foreign ? false : agent?.branch ? agent.branch === b.name : b.current,
        worktree: b.worktree,
        ahead: b.ahead,
        behind: b.behind,
        subject: b.lastCommitSubject,
        blocked: b.current ? 'current' : b.worktree ? 'worktree' : inWorktree || foreign ? 'elsewhere' : null,
      }))
    : null;
  const worktrees = list?.ok
    ? list.worktrees.map((w): PickerWorktree => {
        const name = pathTail(w.path);
        return {
          path: w.path,
          name,
          branch: w.branch,
          detached: w.detached,
          main: w.main,
          // Found by path, not by `agent.worktree`: that is the name of git's
          // admin directory, which git derives from the folder but rewrites
          // (`wt é` → `wt-é`) and numbers on a clash (`dup` → `dup1`).
          here: foreign ? false : holder !== null ? w.path === holder : !agent?.worktree && w.current,
          locked: w.locked !== null,
          prunable: w.prunable !== null,
        };
      })
    : null;
  const changes = dash?.ok ? dash.staged.length + dash.unstaged.length + dash.untracked.length : 0;
  return { branches, worktrees, inWorktree, inOtherRepo, changes };
}

/** The folder the composer's bar names: the tail of the agent's cwd,
 *  whichever separator the daemon's OS writes. Git's worktree name only
 *  stands in without a cwd: it is not always the folder's (see above). */
export function folderOf(agent: AgentGitInfo | null, cwd: string | null | undefined): string | null {
  if (cwd) return pathTail(cwd);
  return agent?.worktree ?? null;
}

/** A path compared across OSes: one separator, no trailing one, and a
 *  Windows drive path in one case, as NTFS compares it. */
function comparable(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(p) ? p.toLowerCase() : p;
}

/** The worktree holding `cwd`: the deepest one whose path contains it, as
 *  worktrees may nest (`.worktrees/` inside the main checkout). */
export function holderOf(paths: string[], cwd: string): string | null {
  const target = comparable(cwd);
  let best: string | null = null;
  let depth = -1;
  for (const path of paths) {
    const p = comparable(path);
    if ((target === p || target.startsWith(p + '/')) && p.length > depth) {
      best = path;
      depth = p.length;
    }
  }
  return best;
}
