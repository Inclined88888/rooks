/**
 * Module `terminal-native` — opening the host machine's terminal and
 * revealing a folder in the file manager. Tier `opt`, requires the `gui`
 * capability: without a graphical session, there's nothing to open.
 * No web shell, by choice (see `terminal.ts`).
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerRoutes } from './routes.js';

export const manifest: ModuleManifest = {
  name: '@rooks/terminal-native',
  tier: 'opt',
  requires: ['gui'],
  inject: ['http', 'db'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  // Mounted at the root: the routes already carry their public prefix,
  // moving them would break the front proxy, the CLI and the agents.
  registerRoutes(ctx.http.router());
}
