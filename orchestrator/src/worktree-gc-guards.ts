/**
 * Guards of the worktree garbage collector, isolated from `worktree-gc.ts` to
 * be testable: this module imports neither `db.js` nor `agent.js`, so it does not
 * touch SQLite at load.
 *
 * What they protect: a freshly created worktree is NOT a leftover.
 * On 2026-08-13, a GC pass fell between the creation of the worktree of
 * task b73f0bd2 and the write of its `worktree_path` column. The folder
 * being in no known path and its branch still pointing at HEAD
 * (no commit), it was judged orphaned and integrated: deleted. The agent's
 * mission died 82 ms after its spawn, cwd missing.
 */
import { statSync } from 'node:fs';

/** Was the folder touched too recently for us to touch it?
 *  An unreadable path is treated as young: we abstain rather than
 *  delete on the strength of a failed `stat`. */
export function isWithinGrace(path: string, graceMs: number, now: number): boolean {
  try {
    return now - statSync(path).mtimeMs < graceMs;
  } catch {
    return true;
  }
}

export type OrphanVerdict = 'skip' | 'grace' | 'candidate';

/**
 * Is a folder of `~/.rooks/worktrees/` a candidate for deletion?
 *
 * - `skip`: it belongs to a living task — nothing to decide, move on.
 * - `grace`: too young to be a leftover; to look at again on the next pass.
 * - `candidate`: no task claims it any more. The absolute guard
 *   (unintegrated branch = never delete) remains to be applied next,
 *   it lives in `worktree-gc.ts` because it queries git.
 */
export function classifyOrphan(input: {
  /** Path already claimed by a task's `worktree_path` column. */
  isKnownPath: boolean;
  /** A task carries the folder's id, whatever its worktree_path column. */
  taskExists: boolean;
  withinGrace: boolean;
}): OrphanVerdict {
  if (input.isKnownPath || input.taskExists) return 'skip';
  if (input.withinGrace) return 'grace';
  return 'candidate';
}
