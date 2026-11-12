/**
 * Module `@rooks/secrets-vault` — the secrets vault: its routes, its broker, its access
 * journal, and the migration of `~/.rooks/secrets.env` into it
 * (SECRETS-VAULT.md §9.1, §6.2, §8 and §10).
 *
 * Tier `opt`: an install may run its agents without a vault at all. Switching
 * it off takes away the routes, the broker, the access journal and the
 * `secrets.env` import in one go — and the paths that live outside this module
 * (agent spawn, plugin context) then take the degraded path of §4.4 rather than
 * reading a vault nobody asked for. `secrets.env` still reaches the DAEMON's own
 * environment (`boot.ts` → `loadSecretsAtBoot`, docs/SECRETS.md): that predates
 * the vault and is what `telegram` reads.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { SECRETS_MODULE_ID } from '../../secrets/availability.js';
import { importSecretsEnvAtBoot, recoverVaultRotation } from '../../secrets/store.js';
import { bus, type BusEvent } from '../../bus.js';
import { registerRoutes } from './routes.js';
import { endSecretRequestsOfMission, sweepSecretRequests } from './requests.js';

/** How often a card past its expiry is closed and its agent told. */
const REQUEST_SWEEP_MS = 60_000;

export const manifest: ModuleManifest = {
  name: SECRETS_MODULE_ID,
  tier: 'opt',
  inject: ['http'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  registerRoutes(ctx.http.router());
  // A vault that cannot open must not take the daemon down with it: the import
  // is a convenience, and §4.4 already says an unresolvable key means degraded
  // mode — secrets unavailable, dependent modules disabling themselves — never
  // a boot failure and never a fresh key.
  try {
    // Finish or discard a rotation the previous process did not survive (§4.5),
    // at boot rather than at the first decryption. `vaultKey()` keeps its own
    // lazy guard for the CLI, which never runs `apply()`, but waiting for it
    // here would leave the daemon serving `configured: true` on a vault that is
    // in fact shut, and would surface a real corruption as an opaque spawn
    // failure hours later instead of a warning at startup.
    const recovered = recoverVaultRotation();
    if (recovered !== 'none') console.log(`[secrets] interrupted key rotation ${recovered}`);
    importSecretsEnvAtBoot();
  } catch (e) {
    console.warn(`[secrets] vault unavailable at boot: ${(e as Error).message}`);
  }
  // A value lent to a mission (`secret_request`, lifetime `once` / `mission`)
  // does not outlive it; a card does not outlive its expiry. The sweep also
  // catches what a daemon that died mid-mission left behind.
  ctx.effect(() => {
    const onEvent = (ev: BusEvent): void => {
      if (ev.kind === 'mission_complete') endSecretRequestsOfMission(ev.missionId);
    };
    bus.on('event', onEvent);
    sweepSecretRequests();
    const timer = setInterval(() => sweepSecretRequests(), REQUEST_SWEEP_MS);
    timer.unref?.();
    return () => { bus.off('event', onEvent); clearInterval(timer); };
  });
}
