/**
 * Module `routines` — recurring tasks driven by a cron expression.
 * Tier `std`. Injects `kanban`: a routine creates tasks.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerRoutes } from './routes.js';
import { startRoutines } from '../../routines.js';

export const manifest: ModuleManifest = {
  name: '@rooks/routines',
  tier: 'std',
  inject: ['http', 'db', 'kanban'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  // Mounted at the root: the routes already carry their public prefix,
  // moving them would break the front proxy, the CLI and the agents.
  registerRoutes(ctx.http.router());

  ctx.effect(() => startRoutines());
}
