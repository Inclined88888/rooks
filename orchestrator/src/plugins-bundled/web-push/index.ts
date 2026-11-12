/**
 * Module `web-push` — system notifications on the phone, through Web Push.
 * Tier `opt`: nothing requires it, and without VAPID keys it is inert anyway.
 *
 * `inject: ['notifications']`: no notification centre, no push. Push is not a
 * parallel channel, it relays `createNotification` — it would have nothing to
 * relay.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerPushSink } from '../../notifications.js';
import { registerRoutes } from './routes.js';
import { pushCloseTag, pushNotification, pushTag, pushTagForAnchor } from './push.js';

export const manifest: ModuleManifest = {
  name: '@rooks/web-push',
  tier: 'opt',
  inject: ['http', 'db', 'notifications'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  // Mounted at the root: the routes already carry their public prefix,
  // moving them would break the front proxy and the browser subscription.
  registerRoutes(ctx.http.router());

  // The notification centre does not know about push: it knows this contract.
  // Turning this module off removes the sink, hence the fan-out — without the
  // centre changing a line.
  ctx.effect(() => registerPushSink({
    notify: (n, opts) => pushNotification(n, { permissionId: opts.permissionId }),
    closeFor: (n) => pushCloseTag(pushTag(n)),
    closeForAnchor: (anchor) => pushCloseTag(pushTagForAnchor(anchor)),
  }));
}
