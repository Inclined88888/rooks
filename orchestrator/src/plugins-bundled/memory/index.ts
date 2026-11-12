/**
 * Module `@rooks/memory` — ROOKS's memory: rules injected at spawn, raw facts,
 * agent and project memories, promotion proposals, agent docs.
 * Tier `opt`: switching it off leaves a running ROOKS with no memory — the
 * preamble ships without its memory block, no rule is recalled at spawn, no
 * overnight job runs. `dreams` depends on it (catalog `dependsOn`) and follows.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerRoutes } from './routes.js';
import { backfillMemoryFromFiles } from '../../memory-migrate.js';
import { seedObjectives } from '../../global-digest.js';
import { startMemoryCapture } from '../../memory-capture.js';
import { startMemorySynthesizer } from '../../memory-synthesize.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Ordering token: memory is primed and its jobs armed. */
    '@rooks/memory': Record<string, never>;
  }
}

export const manifest: ModuleManifest = {
  name: '@rooks/memory',
  tier: 'opt',
  inject: ['http', 'db'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  // Mounted at the root: the routes already carry their public prefix,
  // moving them would break the front proxy, the CLI and the agents.
  registerRoutes(ctx.http.router());

  ctx.provide('@rooks/memory', {});

  // Files → DB backfill, idempotent, BEFORE anything that reads memory.
  try { backfillMemoryFromFiles(); }
  catch (err) { console.warn('[rooks] memory backfill failed:', (err as Error).message); }
  seedObjectives();

  ctx.effect(() => startMemoryCapture());
  ctx.effect(() => startMemorySynthesizer());
}
