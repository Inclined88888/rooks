/**
 * Native Electron Chromium shared with remote clients through the daemon.
 * Docker/Traefik routes remain available for existing server deployments;
 * their reconciliation is registered only on hosts with both capabilities.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerRoutes } from './routes.js';
import { registerReconcileRule } from '../../reconcile.js';
import { closeIdleBrowserSessions, reconcileBrowserSessions } from '../../browser-sessions.js';
import { registerNativeBrowserRoutes } from './native-routes.js';
import { getHost } from '../../host/index.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Order token: the native browser routes are mounted (`@rooks/browser-recording` waits for it). */
    '@rooks/browser-embedded': Record<string, never>;
  }
}

export const manifest: ModuleManifest = {
  name: '@rooks/browser-embedded',
  tier: 'opt',
  // Native sessions need no Docker/Traefik; legacy reconciliation is gated below.
  requires: [],
  inject: ['http', 'db'],
  // Browser access is included in every edition. Profile authorization still applies.
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  // Mounted at the root: the routes already carry their public prefix,
  // moving them would break the front proxy, the CLI and the agents.
  registerNativeBrowserRoutes(ctx.http.router());
  registerRoutes(ctx.http.router());
  ctx.provide('@rooks/browser-embedded', {});

  if (!getHost().capabilities().includes('containers') || !getHost().capabilities().includes('traefik')) return;

  ctx.effect(() => registerReconcileRule({
    name: 'browser-sessions',
    invariant: 'The embedded browser table reflects the containers actually alive.',
    cadence: 'both',
    run: reconcileBrowserSessions,
  }));
  ctx.effect(() => registerReconcileRule({
    name: 'browser-sessions-idle',
    invariant: 'No embedded browser stays open longer than ROOKS_BROWSER_IDLE_MINUTES without activity.',
    cadence: 'interval',
    run: closeIdleBrowserSessions,
  }));
}
