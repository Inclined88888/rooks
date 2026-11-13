/**
 * Module `grepai` — per-project local semantic index and its watchers.
 * Tier `dev`, requires the `grepai` binary and `systemd` (watchers run as
 * transient units, outside the daemon's cgroup).
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerRoutes } from './routes.js';
import { registerReconcileRule } from '../../reconcile.js';
import { reconcileWatchers } from '../../grepai.js';

export const manifest: ModuleManifest = {
  name: '@rooks/grepai',
  tier: 'dev',
  requires: ['grepai', 'systemd'],
  inject: ['http', 'db'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  // Mounted at the root: the routes already carry their public prefix,
  // moving them would break the front proxy, the CLI and the agents.
  registerRoutes(ctx.http.router());

  ctx.effect(() => registerReconcileRule({
    name: 'grepai-watchers',
    invariant: 'Every project indexed by grepai and not disabled has a live watcher.',
    cadence: 'both',
    run: reconcileWatchers,
  }));
}
