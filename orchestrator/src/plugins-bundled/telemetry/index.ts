/**
 * Module `@timon/telemetry` — anonymous product analytics of the installed app
 * (`docs/TELEMETRY.md`): a closed list of usage events sent to our
 * self-hosted OpenPanel, under a random installation id.
 *
 * Tier `std`: on by default, and switching the module off stops it like the
 * person's own setting does ("Share anonymous usage statistics",
 * `telemetry.enabled` in `timon.config.json`, `TIMON_TELEMETRY=0`). A source
 * checkout and the test runner send nothing.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { resolvePreference } from './preference.js';
import { registerRoutes } from './routes.js';
import { clearTelemetryRuntime, setTelemetryRuntime, startTelemetry, telemetry } from './runtime.js';

export const manifest: ModuleManifest = {
  name: '@timon/telemetry',
  tier: 'std',
  inject: ['http', 'db'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  registerRoutes(ctx.http.router(), () => (telemetry().active ? telemetry().preference() : resolvePreference()));

  ctx.effect(() => {
    const runtime = startTelemetry();
    setTelemetryRuntime(runtime);
    return () => {
      clearTelemetryRuntime(runtime);
      void runtime.dispose();
    };
  });
}
