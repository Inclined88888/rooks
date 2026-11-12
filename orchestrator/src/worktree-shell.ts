/**
 * Worktree "shells": what is left in `~/.rooks/worktrees/<id>/` once git has
 * let go of a worktree without the folder going away.
 *
 * `git worktree remove` deletes ignored files too, so a shell is not git's
 * doing: it is a `.grepai/` (tens of Mo, sometimes 80+) written back into the
 * path AFTER the removal by a grepai process that still points at it — the
 * mission's `grepai mcp-serve`, or the project's `grepai watch`, which indexes
 * linked worktrees on its own (the `.grepai/` appears the same second as the
 * worktree). Nothing references the folder any more, so nothing cleaned it:
 * 146 shells, 12 G, on 18/09/2026.
 *
 * Kept free of `db.js` / `agent.js` imports so it stays testable and callable
 * from `worktree.ts` without loading SQLite.
 */
import { lstatSync, readdirSync, readlinkSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { isWithinGrace } from './worktree-gc-guards.js';

/** Absolute paths of the working directories of live grepai processes.
 *  Linux-only by nature: elsewhere `/proc` does not exist, the list is empty
 *  and only the other guards apply. */
function grepaiCwds(): string[] {
  let entries: string[];
  try { entries = readdirSync('/proc'); } catch { return []; } // portability: Linux procfs, empty list elsewhere
  const cwds: string[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const exe = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0')[0] ?? ''; // portability: Linux procfs, guarded by readdirSync above
      if ((exe.split(/[\\/]/).pop() ?? '') !== 'grepai') continue;
      // A process whose cwd was removed reads back as "<path> (deleted)": it
      // still holds the path and can write the index back into it.
      cwds.push(readlinkSync(`/proc/${entry}/cwd`).replace(/ \(deleted\)$/, '')); // portability: Linux procfs, guarded by readdirSync above
    } catch { /* process gone or not ours */ }
  }
  return cwds;
}

/** Is a grepai process (watcher or MCP server) running inside `path`?
 *  Purging under its feet is pointless: it writes the index straight back. */
export function isHeldByGrepai(path: string, cwds: string[] = grepaiCwds()): boolean {
  const target = resolve(path);
  return cwds.some((cwd) => cwd === target || cwd.startsWith(target + sep));
}

export type ShellVerdict = 'purged' | 'not-shell' | 'grace' | 'held';

/**
 * Deletes `path` when it is a worktree shell: a real directory (not a
 * symlink), a DIRECT child of `root`, with no `.git`, older than the grace
 * period and not held by a grepai process.
 *
 * `.git` is the absolute guard: a folder that has one is a live worktree, and
 * nothing here removes a worktree. `rmSync` does not follow symlinks, so a
 * `node_modules` link to the main clone is unlinked, never traversed.
 */
export function purgeShell(
  root: string,
  path: string,
  graceMs: number,
  now: number,
  holders?: string[],
): ShellVerdict {
  const target = resolve(path);
  if (dirname(target) !== resolve(root)) return 'not-shell';
  try {
    if (!lstatSync(target).isDirectory()) return 'not-shell';
  } catch {
    return 'not-shell';
  }
  // lstat, not existsSync: a dangling `.git` link still means "someone's worktree".
  if (lstatSync(join(target, '.git'), { throwIfNoEntry: false })) return 'not-shell';
  if (isWithinGrace(target, graceMs, now)) return 'grace';
  if (isHeldByGrepai(target, holders)) return 'held';
  try {
    rmSync(target, { recursive: true, force: true });
    return 'purged';
  } catch {
    // Locked or already gone: the next pass tries again.
    return 'grace';
  }
}

/**
 * Safety net that reads the disk, not the database: every direct child of
 * `root` that is a shell gets purged, whatever path removed its worktree
 * (merger, `rooks worktree dispose`, an agent's own `git worktree remove`).
 *
 * `isLive(name, path)` protects folders a non-DONE task still claims — its
 * worktree may be about to be recreated at that path.
 */
export function sweepShells(
  root: string,
  graceMs: number,
  now: number,
  isLive: (name: string, path: string) => boolean,
): { purged: number; held: number } {
  const out = { purged: 0, held: 0 };
  let entries: string[];
  try { entries = readdirSync(root); } catch { return out; }
  const holders = grepaiCwds();
  for (const name of entries) {
    const path = join(root, name);
    if (isLive(name, path)) continue;
    const verdict = purgeShell(root, path, graceMs, now, holders);
    if (verdict === 'purged') out.purged += 1;
    else if (verdict === 'held') out.held += 1;
  }
  return out;
}
