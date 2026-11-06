import { existsSync } from 'node:fs';
import { getHost } from './host/index.js';
import type { TaskRow } from './db.js';

/** Null distinguishes an unavailable inspection from an empty branch. */
export type GitInspection = {
  commitCount: number | null;
  uncommittedFiles: string[];
  mergedIntoBase?: boolean | null;
};

type CodeTask = Pick<TaskRow, 'type' | 'branch_name' | 'worktree_path' | 'base_branch'
  | 'pipeline' | 'merged_commit_sha'>;

export function evaluateCodeDone(
  task: CodeTask,
  git: GitInspection,
): string | null {
  if (task.type !== 'code' || !task.branch_name) return null;

  // Only code-self closes after integration; code-group awaits a separate merge.
  if (task.pipeline === 'code-self') {
    if (!task.merged_commit_sha) {
      return `⚠️ [code-gate] No merged_sha declared for ${task.pipeline} task ${task.branch_name}.`;
    }
    if (git.mergedIntoBase === false) {
      return `⚠️ [code-gate] Declared merged_sha ${task.merged_commit_sha} is missing or is not contained in base ${task.base_branch}.`;
    }
    // An unavailable repository must not be reported as a failed merge.
    return null;
  }
  // Marked merged outside the chain: the route checked the sha, and the branch
  // contained in its base has no commits beyond it by definition.
  if (task.merged_commit_sha) return null;
  if (git.commitCount === null || git.commitCount > 0) return null;

  const parts: string[] = [
    `⚠️ [code-gate] Branch ${task.branch_name} has NO commits beyond its base.`,
  ];
  if (git.uncommittedFiles.length > 0) {
    parts.push(
      `Uncommitted files in the worktree (${git.uncommittedFiles.length}):`,
      ...git.uncommittedFiles.map((f) => `  - ${f}`),
      `To recover the work: cd ${task.worktree_path ?? '<missing worktree_path>'} && git add -A && git commit -m "<message>" then push the branch`,
    );
  }
  return parts.join('\n');
}

/** Git failures remain unknown, rather than claiming that work was lost. */
export function inspectGitBranch(
  worktreePath: string | null,
  branchName: string | null,
  baseBranch: string | null,
  pipeline: TaskRow['pipeline'] = null,
  mergedSha: string | null = null,
): GitInspection {
  const unknown: GitInspection = { commitCount: null, uncommittedFiles: [], mergedIntoBase: null };
  if (!worktreePath || !branchName || !baseBranch) return unknown;

  try {
    const host = getHost();
    // Arguments never pass through a shell; refs cannot execute commands.
    const git = (args: string[]) => host.exec('git', args, {
      cwd: worktreePath,
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (pipeline === 'code-self') {
      if (!mergedSha) return unknown;
      const base = git(['rev-parse', '--verify', '--end-of-options', `${baseBranch}^{commit}`]);
      if (base.code !== 0) return unknown;
      if (!/^[0-9a-f]{7,40}$/i.test(mergedSha)) return { ...unknown, mergedIntoBase: false };
      const commit = git(['rev-parse', '--verify', '--end-of-options', `${mergedSha}^{commit}`]);
      if (commit.code !== 0) return { ...unknown, mergedIntoBase: false };
      const ancestor = git(['merge-base', '--is-ancestor', commit.stdout.trim(), base.stdout.trim()]);
      return { ...unknown, mergedIntoBase: ancestor.code === 0 ? true : ancestor.code === 1 ? false : null };
    }
    const rev = git(['rev-list', '--count', 'HEAD', `^${baseBranch}`]);
    if (rev.code !== 0) return unknown;
    const raw = rev.stdout.trim();
    const parsed = Number(raw);
    const commitCount = raw && Number.isInteger(parsed) ? parsed : null;
    const status = git(['status', '--porcelain']);
    if (status.code !== 0) return unknown;
    const statusOut = status.stdout.trim();
    const uncommittedFiles = statusOut ? statusOut.split('\n').filter((l) => l.length > 0) : [];
    return { commitCount, uncommittedFiles };
  } catch {
    return unknown;
  }
}

/**
 * Whether `sha` is in `baseBranch` of the repository at `repoPath` (TIM-0109,
 * marking a task merged by hand). `unknown` covers a commit this clone has not
 * fetched yet — a PR merged on GitHub usually is — and any git failure: only
 * a commit git knows and places outside the base is `not_contained`.
 */
export function shaInBase(
  repoPath: string | null,
  baseBranch: string | null,
  sha: string,
): 'contained' | 'not_contained' | 'unknown' {
  if (!repoPath || !baseBranch || !existsSync(repoPath) || !/^[0-9a-f]{7,40}$/i.test(sha)) return 'unknown';
  try {
    const git = (args: string[]) => getHost().exec('git', args, {
      cwd: repoPath,
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const base = git(['rev-parse', '--verify', '--end-of-options', `${baseBranch}^{commit}`]);
    const commit = git(['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`]);
    if (base.code !== 0 || commit.code !== 0) return 'unknown';
    const ancestor = git(['merge-base', '--is-ancestor', commit.stdout.trim(), base.stdout.trim()]);
    return ancestor.code === 0 ? 'contained' : ancestor.code === 1 ? 'not_contained' : 'unknown';
  } catch {
    return 'unknown';
  }
}
