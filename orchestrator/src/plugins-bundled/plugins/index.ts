/**
 * Module `@rooks/plugins` — the third-party plugin loader's live state and
 * browser-half server. Tier `core`: the front queries these routes to
 * compose the UI, even when no plugin is installed.
 *
 * The `/api/plugins/*` routes no longer belong to `index.ts` (no route has
 * lived there since P1). The loader itself is attached to the Express app
 * by `boot.ts` after the bundled tree — these routes re-read it on every
 * request.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerRoutes } from './routes.js';
import { startIntegrationRuntime } from '../../plugins/integration-runtime.js';
import { registerIntegrationWebhook } from '../../plugins/integration-http.js';
import { registerIntegrationReceiptRoutes } from '../../plugins/integration-receipts-http.js';
import { registerPluginWebhookRoute } from '../../plugins/webhooks.js';
import { daemonUserConnectionHost } from '../../plugins/user-connections-host.js';
import { startUserConnections } from '../../plugins/user-connections.js';
import { registerUserConnectionRoutes } from '../../plugins/user-connections-http.js';

export const manifest: ModuleManifest = {
  name: '@rooks/plugins',
  tier: 'core',
  inject: ['http'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  const router = ctx.http.router();
  registerRoutes(router);
  const runtime = startIntegrationRuntime();
  ctx.effect(() => runtime.stop);
  registerIntegrationWebhook(router, runtime.service);
  registerIntegrationReceiptRoutes(router, runtime.service.store);
  const connections = startUserConnections(runtime.service.store.db, daemonUserConnectionHost());
  ctx.effect(() => connections.stop);
  registerUserConnectionRoutes(router, connections.service);
  registerPluginWebhookRoute(router);
}
