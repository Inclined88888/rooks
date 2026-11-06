/**
 * Module `git` — a project's repository state (branches, checkout, GitHub
 * remote) and an agent's repo state. Tier `std`, requires the `git` binary.
 *
 * Independent of the Kanban on purpose (TODO #275): the Git cards of the chat
 * read these routes, and they lived in `kanban-code`, licensed and dependent
 * on `@timon/kanban` — switching the board off or lacking the code licence
 * killed them. `kanban-code` keeps what belongs to tasks (worktrees, merge).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerRoutes } from './routes.js';

export const manifest: ModuleManifest = {
  name: '@timon/git',
  tier: 'std',
  requires: ['git'],
  inject: ['http', 'db'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  // Mounted at the root: the routes already carry their public prefix,
  // moving them would break the front proxy, the CLI and the agents.
  registerRoutes(ctx.http.router());
}
