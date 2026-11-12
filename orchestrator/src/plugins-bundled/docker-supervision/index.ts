/**
 * Module `docker-supervision` — state and control of a project's containers.
 * Tier `dev`, requires the `containers` capability: without usable Docker,
 * these routes can only return errors.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerRoutes } from './routes.js';

export const manifest: ModuleManifest = {
  name: '@rooks/docker-supervision',
  tier: 'dev',
  requires: ['containers'],
  inject: ['http', 'db'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  // Mounted at the root: the routes already carry their public prefix,
  // moving them would break the front proxy, the CLI and the agents.
  registerRoutes(ctx.http.router());
}
