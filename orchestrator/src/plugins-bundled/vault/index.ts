/**
 * Module `vault` — reads the knowledge vault (note graph, disk, note).
 *
 * Tier `opt`: an installation without an Obsidian vault has no need for it,
 * and hiding the corresponding nav is better than a tab that renders an error.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerRoutes } from './routes.js';

export const manifest: ModuleManifest = {
  name: '@timon/vault',
  tier: 'opt',
  inject: ['http', 'db'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  // Mounted at the root: the routes already carry their `/api/vault/…`
  // prefix, moving them would break the front proxy and the CLI.
  registerRoutes(ctx.http.router());
}
