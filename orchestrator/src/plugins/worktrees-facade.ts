/**
 * `ctx.worktrees` (API 10): the git worktree of a Kanban task — read where it
 * is, force-create it, dispose it once the task is merged.
 *
 * Bounded by the caller as `ctx.kanban` is: in a request, the tasks that
 * account can see; in a job, the tasks `plugin:<id>` owns. A task outside that
 * view answers as one that does not exist (`not_found`, `undefined` for `info`).
 * Creation and disposal go through `worktree-service.ts`, the code behind
 * `POST|DELETE /api/tasks/:id/worktree`, plus rules of the facade's own:
 *
 *  - `dispose` only touches a task that is DONE **and** carries a merged commit
 *    (`conflict` otherwise): disposing a live task destroys the coder's
 *    uncommitted work, and a branch that was never merged is lost with it;
 *  - `create` refuses a task that already has a worktree or is DONE: the
 *    dispatcher creates one for every `code` task, a second is a mistake;
 *  - `base` is a branch or ref name, never an option for git.
 *
 * Both need the `@rooks/kanban-code` module, which can be absent.
 */
import type { DbViewer } from '../db.js';
import { moduleActive } from '../kernel/module-state.js';
import { scopedDb } from '../users/scoped-db.js';
import {
  createTaskWorktree, disposeTaskWorktree, worktreeOfTask, WorktreeServiceError,
} from '../worktree-service.js';

import type { PluginWorktree, PluginWorktreeErrorCode } from './contract/worktrees.js';
export type { PluginWorktree, PluginWorktreeErrorCode } from './contract/worktrees.js';

export class PluginWorktreeError extends Error {
  constructor(readonly code: PluginWorktreeErrorCode, message: string = code) {
    super(message);
    this.name = 'PluginWorktreeError';
  }
}

export type WorktreeCallerScope = { pluginId: string; viewer: DbViewer | null };

export type ScopedWorktrees = {
  info(taskId: string): PluginWorktree | undefined;
  create(taskId: string, opts?: { base?: string }): Promise<PluginWorktree>;
  dispose(taskId: string, opts?: { force?: boolean }): Promise<{ disposed: boolean }>;
};

export function worktreesFor(scope: WorktreeCallerScope): ScopedWorktrees {
  const { viewer } = scope;
  const active = (): void => {
    if (!moduleActive('@rooks/kanban-code')) throw new PluginWorktreeError('module_disabled', 'module @rooks/kanban-code is disabled');
  };
  const taskOf = (id: unknown) => (typeof id === 'string' ? scopedDb(viewer).getTask(id) : undefined);
  const view = (task: NonNullable<ReturnType<typeof taskOf>>): PluginWorktree => {
    const w = worktreeOfTask(task);
    return { taskId: w.task_id, path: w.worktree_path, branch: w.branch_name, base: w.base_branch, mergedCommitSha: w.merged_commit_sha };
  };
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (err) {
      // `busy` (a running task) is the contract's `conflict`.
      if (err instanceof WorktreeServiceError) throw new PluginWorktreeError(err.code === 'busy' ? 'conflict' : err.code, err.message);
      throw err;
    }
  };

  return {
    info(taskId) {
      const task = taskOf(taskId);
      return task ? view(task) : undefined;
    },

    async create(taskId, opts = {}) {
      active();
      const task = taskOf(taskId);
      if (!task) throw new PluginWorktreeError('not_found', `task not found: ${String(taskId)}`);
      if (opts.base !== undefined && typeof opts.base !== 'string') throw new PluginWorktreeError('invalid', 'base must be a string');
      if (task.worktree_path) throw new PluginWorktreeError('conflict', 'the task already has a worktree');
      if (task.status === 'DONE') throw new PluginWorktreeError('conflict', 'the task is DONE');
      await guard(() => createTaskWorktree(task, opts.base));
      return view(scopedDb(viewer).getTask(task.id)!);
    },

    async dispose(taskId, opts = {}) {
      active();
      const task = taskOf(taskId);
      if (!task) throw new PluginWorktreeError('not_found', `task not found: ${String(taskId)}`);
      if (!task.worktree_path) return { disposed: false };
      if (task.status !== 'DONE' || !task.merged_commit_sha) {
        throw new PluginWorktreeError('conflict', 'the task is not DONE and merged: disposing its worktree would destroy unmerged work');
      }
      return guard(() => disposeTaskWorktree(task, opts.force === true));
    },
  };
}
