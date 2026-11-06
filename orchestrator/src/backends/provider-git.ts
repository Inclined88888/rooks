/**
 * S3 bis — `ctx.provider.git.writableRoots()`: the folders a sandboxed CLI must be able to write
 * for `git commit` to work in a working directory (`docs/PROVIDERS-SDK.md` § 6.1).
 *
 * The daemon computes them, because a plugin has no way to run `git` (`ctx.provider.binary` serves
 * the programs its manifest declares, and a root it names widens a sandbox). The logic is the one
 * the codex dialect carried since the night of 2026-08-22, moved here verbatim.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { getHost } from '../host/index.js';

/** Git directories to make writable so that the agent can commit.
 *
 *  Codex's `workspace-write` sandbox mounts the git directory as a READ-ONLY
 *  bind, **even when `.git` physically sits inside the writable cwd** — it is a
 *  guardrail against history rewriting, enforced by bwrap/Landlock, hence at
 *  kernel level and not bypassable from the agent. Reproduced outside TIMON on
 *  codex-cli 0.147:
 *
 *    cd <repo> && codex sandbox -c sandbox_mode='"workspace-write"' -- \
 *      bash -lc 'git add x && git commit -m y'
 *    → fatal: Unable to create '<repo>/.git/index.lock': Read-only file system
 *
 *  (`touch <cwd>/file` succeeds in the same run: only `.git` is locked.)
 *  Declaring the directory in `writable_roots` lifts the block — it is the only
 *  lever, codex having no finer granularity. Without it, a codex agent (GPT,
 *  but also DeepSeek/Kimi through Ollama Cloud, which go through this same
 *  dialect) can edit the files of a `code` task but never commit them.
 *
 *  We delegate resolution to git itself rather than to a heuristic on
 *  `<cwd>/.git`: it is the only way to cover in one go the normal repository,
 *  the linked worktree (`--git-dir` = `<repo>/.git/worktrees/<id>`,
 *  `--git-common-dir` = `<repo>/.git`, both needed — index and HEAD on one
 *  side, `objects/` and `refs/` on the other), a `cwd` in a subdirectory of the
 *  repository, and an externalised `.git` (`--separate-git-dir`, submodule).
 *  The orchestrator runs in host mode, outside the sandbox: this `rev-parse`
 *  runs unhindered. */
export function gitWritableRoots(cwd: string): string[] {
  let raw: string;
  try {
    const r = getHost().exec(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (r.code !== 0) throw new Error(r.stderr);
    raw = r.stdout;
  } catch {
    return legacyGitDirFallback(cwd); // cwd outside a repo, or git < 2.31 / missing
  }
  const roots = raw
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && isAbsolute(p))
    // The sandbox reasons in resolved paths: a writable_root passed in its
    // symlinked form does not match the bind mount and the block persists.
    .map((p) => { try { return realpathSync(p); } catch { return p; } })
    .filter((p) => existsSync(p));
  // git-dir ≠ git-common-dir ⇔ linked worktree. That is the only case where
  // the main repository's working tree lies outside the sandboxed cwd (see
  // mainWorktreeRoot). Deduplicated FIRST: in a normal repository git returns
  // the same path twice.
  const unique = [...new Set(roots)];
  const linked = unique.length > 1;
  return linked ? [...new Set([...unique, ...mainWorktreeRoot(cwd)])] : unique;
}

/**
 * Working tree of the MAIN repository, when the cwd is a linked worktree.
 *
 * The `.git` directories are enough to commit INSIDE the worktree, but not to
 * integrate its work: a `merge` task fast-forwards in the main repository,
 * which writes files of its working tree — outside the sandboxed cwd, hence
 * read-only. Symptom on the agent side: "Read-only file system" at
 * fast-forward time, after a merge that had nonetheless been perfectly
 * prepared (night of 2026-08-22 on nimbus — the fast-forward had to be redone
 * by hand, then merges were routed away from codex).
 *
 * Returns empty outside a linked worktree: in a normal repository the main
 * repository IS the cwd, already writable, and we widen nobody's perimeter.
 */
function mainWorktreeRoot(cwd: string): string[] {
  try {
    const r = getHost().exec('git', ['worktree', 'list', '--porcelain'], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.code !== 0) return []; // git < 2.7, or cwd outside a repo
    const raw = r.stdout;
    // `git worktree list` ALWAYS lists the main repository first.
    const main = /^worktree (.+)$/m.exec(raw)?.[1]?.trim();
    if (!main) return [];
    const resolved = (() => { try { return realpathSync(main); } catch { return main; } })();
    if (resolved === cwd || !existsSync(resolved)) return []; // we ARE the main one
    return [resolved];
  } catch {
    return []; // git < 2.7, or cwd outside a repo — rev-parse already settled it
  }
}

/** Fallback when `git rev-parse` is unusable: we fall back on reading
 *  `<cwd>/.git` directly, whether a directory (normal repository) or a
 *  `gitdir: ...` file (linked worktree). Less complete — it sees neither a cwd in
 *  a subdirectory nor an externalised `.git` — but better than nothing. */
function legacyGitDirFallback(cwd: string): string[] {
  const dotGit = join(cwd, '.git');
  let stat;
  try {
    stat = statSync(dotGit);
  } catch {
    return [];
  }
  if (stat.isDirectory()) return [dotGit];
  const raw = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
  if (!raw) return [];
  const gitdir = isAbsolute(raw) ? raw : resolve(cwd, raw);
  // <repo>/.git/worktrees/<id> → <repo>/.git
  const common = dirname(dirname(gitdir));
  return [gitdir, common].filter((p) => existsSync(p));
}
