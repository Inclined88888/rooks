/**
 * Module `kanban-code` — the "code" half of the Kanban: per-task git
 * worktrees, integration. Tier `dev`, requires the `git` binary. The
 * project's git routes live in `@timon/git`, which this module depends on.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerRoutes } from './routes.js';
import { whenProvidersLoaded } from '../../backends/registry.js';
import { seedLibrarianAgent, startLibrarian, reconcileLibrarianConfig } from '../../librarian.js';
import { startMergeIntegrityCheck } from '../../merge-integrity.js';
import { startDeployHook } from '../../deploy-hook.js';
import { registerReconcileRule } from '../../reconcile.js';
import {
  reconcileMissingChangesRequested,
  reconcileMissingMerges,
  reconcileMissingReviews,
} from '../../verification-loop.js';

export const manifest: ModuleManifest = {
  name: '@timon/kanban-code',
  tier: 'dev',
  requires: ['git'],
  inject: ['http', 'db', 'kanban'],
  // Sold module (§10.7): only runs if the license names it.
  licensed: true,
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  // Mounted at the root: the routes already carry their public prefix,
  // moving them would break the front proxy, the CLI and the agents.
  registerRoutes(ctx.http.router());

  ctx.effect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    void whenProvidersLoaded().then(() => {
      if (!active) return;
      seedLibrarianAgent();
      stop = startLibrarian();
    }).catch((error: Error) => console.error(`[librarian] initialization failed: ${error.message}`));
    return () => { active = false; stop?.(); };
  });
  ctx.effect(() => startMergeIntegrityCheck());
  ctx.effect(() => startDeployHook());

  // Invariants specific to the code → review → merge chain. Registered here and
  // not in `reconcile.ts`: that one must not import a module the
  // installation may not have (see step 1.3 bis).
  ctx.effect(() => registerReconcileRule({
    name: 'code-without-review',
    invariant: 'Every DONE code task in the full pipeline with a non-empty diff has a child review task.',
    cadence: 'both',
    run: reconcileMissingReviews,
  }));
  ctx.effect(() => registerReconcileRule({
    name: 'review-without-merge',
    invariant: 'Every DONE review with verdict `pass` has a child merge task.',
    cadence: 'both',
    run: reconcileMissingMerges,
  }));
  ctx.effect(() => registerReconcileRule({
    name: 'changes-requested-without-iteration',
    invariant: 'Every DONE review with verdict `changes_requested` in a verification chain has a code iteration N+1 on that chain (unless the iteration cap is reached).',
    cadence: 'both',
    run: reconcileMissingChangesRequested,
  }));
  ctx.effect(() => registerReconcileRule({
    name: 'librarian-config',
    invariant: 'The on-disk librarian config matches what the code requires.',
    cadence: 'both',
    run: reconcileLibrarianConfig,
  }));
}
