/**
 * Module `@timon/browser-annotations` — the user points at an element of the built-in browser,
 * says what is wrong with it, and an agent reads the batch and resolves it (TODO #468).
 *
 * The sensor itself (preload + engine) stays in the desktop core: it needs Electron's privileges.
 * This module keeps what the daemon owns: the sealed store, the routes and the retention. It
 * injects `@timon/browser-embedded`: without the browser there is nothing to annotate.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerReconcileRule } from '../../reconcile.js';
import { settingInt } from '../../settings.js';
import { bus } from '../../bus.js';
import { purgeBrowserAnnotations } from '../../browser-annotations.js';
import { registerBrowserAnnotationRoutes } from './routes.js';
import { relayAnnotationStatus } from './post.js';

export const manifest: ModuleManifest = {
  name: '@timon/browser-annotations',
  tier: 'opt',
  inject: ['http', 'db', '@timon/browser-embedded'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  // Mounted at the root: the routes carry their public prefix, the one the front proxy relays.
  registerBrowserAnnotationRoutes(ctx.http.router());

  // Not behind the Docker guard of `@timon/browser-embedded`: annotations exist on every host.
  ctx.effect(() => registerReconcileRule({
    name: 'browser-annotations-retention',
    invariant: 'No open browser annotation outlives TIMON_BROWSER_ANNOTATION_RETENTION_DAYS, and no resolved or dismissed one outlives TIMON_BROWSER_ANNOTATION_RESOLVED_RETENTION_DAYS after its resolution.',
    cadence: 'both',
    run: () => {
      purgeBrowserAnnotations(settingInt('TIMON_BROWSER_ANNOTATION_RETENTION_DAYS'), settingInt('TIMON_BROWSER_ANNOTATION_RESOLVED_RETENTION_DAYS'));
    },
  }));

  // An annotation resolved or dismissed moves its card in the thread of the mission it was sent to.
  ctx.effect(() => {
    bus.on('event', relayAnnotationStatus);
    return () => { bus.off('event', relayAnnotationStatus); };
  });
}
