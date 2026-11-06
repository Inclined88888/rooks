/**
 * Module `@timon/backends` — LLM backends catalog.
 * Tier `core`: without a backend, no mission can be launched.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerRoutes } from './routes.js';
import { registerCustomBackendRoutes } from './custom-routes.js';
import { migrateBackendKeys } from './backend-keys.js';
import { registerAccountRoutes } from './account-routes.js';
import { registerBinaryRoutes } from './binary-routes.js';
import { registerProviderCliRoutes } from './provider-cli-routes.js';
import { startCliVersionSweep } from '../../provider-cli-versions.js';
import { purgeLoginStaging } from '../../backends/account-login.js';
import { watchLocalBackends } from '../../backends/local-profiles.js';
import { acpRegistryService } from '../../providers/acp-registry/index.js';
import { providersPending } from '../../backends/registry.js';
import { startQuotaRecheckSweep } from '../../backend-recheck.js';

export const manifest: ModuleManifest = {
  name: '@timon/backends',
  tier: 'core',
  inject: ['http', 'db'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  // Mounted at the root: the routes already carry their public prefix,
  // moving them would break the front proxy, the CLI and the agents.
  const router = ctx.http.router();
  registerRoutes(router);
  registerCustomBackendRoutes(router);
  registerAccountRoutes(router);
  registerBinaryRoutes(router);
  registerProviderCliRoutes(router);
  // A flow does not outlive the daemon that ran it: its staging is debris.
  purgeLoginStaging();

  // Backends the user added as `~/.timon/backends/*.json`: loaded now, then
  // followed — a file dropped or removed takes effect without a restart.
  ctx.effect(() => watchLocalBackends());
  // Keys stored by "Add a provider" before TODO #531 (5-B) were shared with
  // every mission: reserved to their backend now, when that is certain.
  try {
    migrateBackendKeys();
  } catch (err) {
    console.warn(`[backends] provider keys not migrated: ${(err as Error).message}`);
  }

  // Agents installed from the ACP registry: each one is hashed again before it
  // is registered (a file altered since the install is refused). In the
  // background, like the model discovery below: a large tree must not delay boot.
  // The boot does not wait, but whatever acts on the registry does (`providersPending`).
  const acp = acpRegistryService();
  const restored = acp.restore().catch((err: Error) => console.warn(`[acp-registry] restore: ${err.message}`));
  providersPending(restored);
  ctx.effect(() => () => acp.dispose());

  // A quota exclusion is re-tested against the usage probe on a timer, not
  // only when a spawn comes: an account nobody picks would otherwise stay
  // "Out of quota" until its estimate ran out (TIM-0122).
  ctx.effect(() => startQuotaRecheckSweep());
  // The installed and published versions of the AI CLIs, for "Update available": shortly after
  // boot, then every TIMON_CLI_UPDATE_INTERVAL_HOURS. Never on a request's path.
  // Not under the test runner: a suite that boots the kernel must not ask npm for anything.
  if (!process.env.NODE_TEST_CONTEXT) ctx.effect(() => startCliVersionSweep());
  // The CLIs the machine cannot run, and the models the providers list, are looked at once the providers
  // shipped as plugins are registered: `kernel-boot.ts`, right after the plugin loader.
}
