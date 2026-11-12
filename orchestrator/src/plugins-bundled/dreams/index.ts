/**
 * Module `dreams` — the overnight pass that proposes improvement leads, and
 * the project scoring it ranks them with. Tier `std`, injects `@rooks/memory`
 * (both passes read the long-term memory).
 *
 * Split out of the former core module (chantier "fin du tier core") : dreaming and scoring
 * are one feature you must be able to switch off, the later-list is another.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerRoutes } from './routes.js';
import { seedDreamInstructions, startDreamer } from '../../dreaming.js';
import { startProjectScorer } from '../../memory-score.js';

export const manifest: ModuleManifest = {
  name: '@rooks/dreams',
  tier: 'std',
  inject: ['http', 'db', '@rooks/memory'],
  // Sold module (§10.7): only runs if the license names it.
  licensed: true,
};

export const name = manifest.name;
export const inject = manifest.inject;

/**
 * Module options. `ui` is the key the client half already reads to decide
 * whether the surfaces exist (same lever as `@rooks/company`); it governs the
 * two background passes here TOO. One key to flip, and above all no overnight
 * pass burning credits to produce proposals no screen displays any more.
 *
 * Absent means withheld. `toLoaderEntries` only attaches a module's config
 * when it carries options, so the argument arrives `undefined` in the nominal
 * case — and that must read as "off", not the opposite.
 */
type DreamsOptions = { ui?: unknown };

export function apply(ctx: Context, options?: DreamsOptions): void {
  // Mounted at the root: the routes already carry their public prefix,
  // moving them would break the front proxy, the CLI and the agents.
  // Registered even when the feature is withheld: the CLI and the agents
  // address them, and a 404 would read as a broken daemon rather than as a
  // feature that is off.
  registerRoutes(ctx.http.router());

  if (options?.ui !== true) return;

  ctx.effect(() => startProjectScorer());
  ctx.effect(() => startDreamer());
  seedDreamInstructions(); // editable template of the dream directives
}
