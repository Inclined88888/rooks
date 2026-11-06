/**
 * Module `notifications` — in-app notification centre and web push.
 * Tier `std`: active by default, can be disabled. Without it, `timon notify` and the
 * plugins' `ctx.notify` facade become logged no-ops
 * (`src/notifications.ts`), and the notification column disappears from the app.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerRoutes } from './routes.js';
import { registerSoundRoutes } from './sound-routes.js';
import { startNotificationResolver } from '../../notifications.js';
import { dismissOrphanedPermissionNotifications } from '../../permissions.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Ordering token: the notification centre accepts writes. */
    notifications: Record<string, never>;
  }
}

export const manifest: ModuleManifest = {
  name: '@timon/notifications',
  tier: 'std',
  inject: ['http', 'db'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  // Mounted at the root: the routes already carry their public prefix,
  // moving them would break the front proxy, the CLI and the agents.
  registerRoutes(ctx.http.router());
  registerSoundRoutes(ctx.http.router());

  ctx.provide('notifications', {});

  ctx.effect(() => startNotificationResolver());
  // Cards whose permission died with the previous process cannot be answered.
  dismissOrphanedPermissionNotifications();
}
