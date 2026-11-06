/**
 * Module `@timon/browser-recording` — the user records a flow in the built-in browser,
 * reviews it, and a conversion mission turns it into a skill (TODO #461).
 *
 * The recorder itself (preload + engine) stays in the desktop core: it needs Electron's
 * privileges. This module keeps what the daemon owns: the sealed store, the routes, the
 * retention, and the end of a conversion. It injects `@timon/browser-embedded`: without the
 * browser there is nothing to record.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { bus, type BusEvent } from '../../bus.js';
import { registerReconcileRule } from '../../reconcile.js';
import { settingInt } from '../../settings.js';
import { dropStepsOfLearnMission, purgeBrowserRecordings } from '../../browser-recordings.js';
import { registerBrowserRecordingRoutes } from './routes.js';

export const manifest: ModuleManifest = {
  name: '@timon/browser-recording',
  tier: 'opt',
  inject: ['http', 'db', '@timon/browser-embedded'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  // Mounted at the root: the routes carry their public prefix, the one the front proxy relays.
  registerBrowserRecordingRoutes(ctx.http.router());

  // Not behind the Docker guard of `@timon/browser-embedded`: recordings exist on every host.
  ctx.effect(() => registerReconcileRule({
    name: 'browser-recordings-retention',
    invariant: 'No unlearned browser recording outlives TIMON_BROWSER_RECORDING_RETENTION_DAYS, and no learned one keeps its raw steps once its conversion mission is over.',
    cadence: 'both',
    run: () => { purgeBrowserRecordings(settingInt('TIMON_BROWSER_RECORDING_RETENTION_DAYS')); },
  }));

  // The skill is what remains of a learned flow: the raw steps go when the conversion ends.
  ctx.effect(() => {
    const onEvent = (ev: BusEvent): void => {
      if (ev.kind === 'mission_complete') dropStepsOfLearnMission(ev.missionId);
    };
    bus.on('event', onEvent);
    return () => { bus.off('event', onEvent); };
  });
}
