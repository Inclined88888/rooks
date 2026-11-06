/**
 * S2 — `ctx.provider.env()`: the base environment of a mission's process, as the
 * daemon decides it (`agent.ts`, `missionEnv`; `secrets/env.ts`).
 *
 * A provider that inspects the environment — to find the API key a CLI would use,
 * to know whether the user is signed in — has to start from the same base the
 * mission will get, and must not rebuild it: which variables an agent may see,
 * which vault entries it was granted, whether the daemon's own environment leaks,
 * are decisions of the daemon (`SECRETS-VAULT.md` § 6.1).
 *
 *   - A provider SHIPPED INSIDE THE PRODUCT (`trusted`) gets what a product
 *     dialect gets: the system whitelist and the vault slice this mission was
 *     granted (or the daemon's environment, under `secrets.inheritEnv`).
 *   - Any other gets the system whitelist and the identity pointers, nothing from
 *     the vault and nothing from the daemon's environment — the same line
 *     `missionEnv({ untrusted })` draws at launch (`SECURITY.md` § 6.4.1).
 *
 * The mission's token is in neither: it travels as a reference.
 */

import { projectFromCwd } from '../task-project.js';
import { inheritEnvEnabled, secretsEnvFor, systemEnv } from '../secrets/env.js';
import type { ProviderEnvPlan } from './provider-services.js';
import type { BuildSpawnOpts } from './types.js';

export async function providerEnvPlan(input: {
  spawn: BuildSpawnOpts;
  trusted: boolean;
  /** Names the provider declared `passthroughEnv` (C6): copied from the daemon's environment, non-secret by declaration. */
  passthrough?: readonly string[];
}): Promise<ProviderEnvPlan> {
  const { spawn } = input;
  const project = spawn.cfg.project ?? projectFromCwd(spawn.cfg.cwd) ?? null;
  // Late, for the cycle `agent ↔ backends ↔ plugins`: the identity pointers live with the launch.
  const { missionIdentityEnv } = await import('../agent.js');
  const identity = missionIdentityEnv({ missionId: spawn.missionId, agentName: spawn.agentName }, project ?? '');
  const base: NodeJS.ProcessEnv = input.trusted
    ? (inheritEnvEnabled() ? { ...process.env } : { ...systemEnv(), ...secretsEnvFor({ agent: spawn.agentName, project }) })
    : { ...systemEnv() };
  const passthrough: NodeJS.ProcessEnv = {};
  for (const name of input.passthrough ?? []) {
    const value = process.env[name];
    if (value !== undefined) passthrough[name] = value;
  }
  const merged = { ...base, ...passthrough, ...identity };
  // Never the token, whatever a spec or the daemon's environment carried.
  for (const key of Object.keys(merged)) if (key.toUpperCase() === 'TIMON_API_TOKEN') delete merged[key];
  return {
    env: Object.freeze(Object.fromEntries(Object.entries(merged).filter((e): e is [string, string] => typeof e[1] === 'string'))),
    project,
  };
}
