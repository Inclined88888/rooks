/** Public plugin types, extracted from the host implementations (TODO #512). */
/** The worktree of a task, as a plugin sees it. Every field but `taskId` is `null` until one exists. */
export type PluginWorktree = Readonly<{
  taskId: string;
  path: string | null;
  branch: string | null;
  /** The branch the worktree was cut from. */
  base: string | null;
  /** Set once the branch was merged. */
  mergedCommitSha: string | null;
}>;

/** `invalid` (input, no working directory, not a git repo), `not_found`,
 *  `conflict` (already exists, or not merged), `failed` (git refused),
 *  `module_disabled` (`@rooks/kanban-code` is off). */
export type PluginWorktreeErrorCode = 'invalid' | 'not_found' | 'conflict' | 'failed' | 'module_disabled';
