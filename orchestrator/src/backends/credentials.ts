/**
 * Credentials of a backend profile, resolved AT EACH SPAWN.
 *
 * They used to be read once, inside `activeProfiles()`, and cached until the
 * next registry mutation — and a plugin's `env` was captured when it
 * registered. Adding a key meant restarting the daemon, and a provider whose
 * token lives thirty minutes (OAuth device flows) was structurally out of
 * reach: frozen at load, every mission died half an hour later.
 *
 * Two halves, deliberately apart:
 *  - `probeProfileEnv` / `probeResolver` answer "could this profile get its
 *    credentials?" and never keep a value. They govern VISIBILITY, and the
 *    registry re-asks them on every read: what it caches is keyed on their
 *    ANSWER, so anything that changes the answer — a key restored, an entry
 *    made readable again — is seen, whatever caused it;
 *  - `resolveProfileEnv` produces the values, for one spawn, and nothing holds
 *    on to them afterwards.
 *
 * Both halves pick a vault entry through the same `openFirstReadable`, so a
 * profile shown as available is one SOME mission can be served on. Not every
 * mission: visibility without a target answers for the whole instance, and an
 * entry granted to a single project leaves a mission from another one refused
 * at spawn — a scope, not a fault (`docs/BACKEND_PROFILES.md`). When the target
 * is known (a project's picker), `probeProfileEnv` takes it and answers for it.
 *
 * Whatever the question, the backend in it is the PROFILE's: an entry reserved
 * to a backend (`backend:<id>`, TODO #531 decision 5-B) enters that backend's
 * process and no other, whoever asks.
 *
 * Nothing here logs or throws a value: reasons name keys and vault entries,
 * never what they contain.
 */

import { dbApi, type SecretWithGrants } from '../db.js';
import { vaultEnabled } from '../secrets/availability.js';
import type { InjectedSecret } from '../secrets/env.js';
import { isBackendReserved, isValidSecretName, resolveSecretsFor, secretReachesBackend, type SecretTarget } from '../secrets/resolve.js';
import { readSecretValue } from '../secrets/store.js';
import { probeLaunchContext, type BackendLaunchContext, type BackendProfile, type EnvResolver, type SecretRef } from './types.js';

export function isSecretRef(value: unknown): value is SecretRef {
  return typeof value === 'object' && value !== null
    && typeof (value as { secret?: unknown }).secret === 'string';
}

/** A profile whose credentials cannot be produced. `message` is safe to show:
 *  it names what is missing, never a value. */
export class ProfileEnvError extends Error {
  constructor(readonly profileId: string, readonly reason: string) {
    super(`backend \`${profileId}\`: ${reason}`);
    this.name = 'ProfileEnvError';
  }
}

/**
 * Vault references still to satisfy: `envFrom` fills the same child key from
 * the daemon's environment when its source variable is set, and then wins, so
 * the vault is not asked. That is how a built-in provider reads its key from
 * the vault while an install that already has it in `secrets.env` keeps
 * working unchanged.
 */
function secretRefs(profile: BackendProfile): string[] {
  if (typeof profile.env !== 'object' || profile.env === null) return [];
  return Object.entries(profile.env)
    .filter(([key, value]) => isSecretRef(value) && !envSupplies(profile, key))
    .map(([, ref]) => (ref as SecretRef).secret);
}

function envSupplies(profile: BackendProfile, childKey: string): boolean {
  const source = profile.envFrom?.[childKey];
  return !!source && !!process.env[source];
}

/**
 * The daemon's own copy of a profile credential, for a request it makes itself
 * (the Ollama Cloud proxy): the environment first, then a vault entry some
 * mission could receive. Read on every call, so a key added to the vault is
 * used without a restart. Null when there is none; never logged.
 */
export function daemonCredential(profile: BackendProfile, childKey: string): string | null {
  const source = profile.envFrom?.[childKey];
  if (source && process.env[source]) return process.env[source]!;
  const ref = profile.env?.[childKey];
  if (!isSecretRef(ref)) return null;
  let rows: SecretWithGrants[];
  try {
    rows = listVault();
  } catch {
    return null;
  }
  const opened = openFirstReadable(injectable(ref.secret, rows).filter((row) => secretReachesBackend(row, profile.id)).sort(byRecency));
  return 'value' in opened ? opened.value : null;
}

function listVault(): SecretWithGrants[] {
  if (!vaultEnabled()) throw new Error('the secrets vault is disabled');
  return dbApi.listSecrets();
}

/** Most recent write first, then id — the tie-break of `resolveSecretsFor`. */
function byRecency(a: SecretWithGrants, b: SecretWithGrants): number {
  return b.updated_at - a.updated_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Entries whose value may enter an environment under `name`. `broker` entries
 *  never do, grant or no grant. */
function injectable(name: string, rows: readonly SecretWithGrants[]): SecretWithGrants[] {
  return rows.filter((row) => row.name === name && row.mode === 'inject' && isValidSecretName(row.name));
}

/** The target as the vault must see it for `profile`: the backend is the
 *  profile's own, never one a caller supplied. */
function profileTarget(profile: BackendProfile, target: SecretTarget): SecretTarget {
  return { agent: target.agent ?? null, project: target.project ?? null, backend: profile.id };
}

/**
 * The vault entries a reference may designate for `target`, best first —
 * `agent > project > global`, then the most recent write.
 *
 * The order is not re-implemented here: `resolveSecretsFor` IS the precedence
 * of the vault (mode, name validity, grants, tie-breaks), and a reference must
 * designate exactly what an injection would. It answers with one winner per
 * name, so the runners-up are drawn by re-asking on the remaining rows — the
 * ordered list that `openFirstReadable` then walks.
 */
function entriesFor(name: string, rows: readonly SecretWithGrants[], target: SecretTarget): SecretWithGrants[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  let pool = rows.filter((row) => row.name === name);
  const ordered: SecretWithGrants[] = [];
  for (;;) {
    const winner = resolveSecretsFor({ agent: target.agent, project: target.project, backend: target.backend, secrets: pool })[0];
    if (!winner) return ordered;
    ordered.push(byId.get(winner.id)!);
    pool = pool.filter((row) => row.id !== winner.id);
  }
}

/**
 * The first entry of `ordered` that can actually be opened. An unreadable
 * duplicate (sealed under a key nobody holds any more) must not hide a valid
 * entry behind it — for the probe and for the spawn alike, hence one function.
 */
function openFirstReadable(ordered: readonly SecretWithGrants[]): { row: SecretWithGrants; value: string } | { code: string } {
  let code = 'unknown';
  for (const row of ordered) {
    try {
      return { row, value: readSecretValue(row.id) };
    } catch (err) {
      const raised = (err as { code?: unknown }).code;
      if (typeof raised === 'string') code = raised;
    }
  }
  return { code };
}

/**
 * Why this profile is inactive, or null when it can be offered.
 *
 * A reference is OPENED here — and the value dropped — because an entry that
 * exists under a master key nobody can read any more is exactly the case that
 * must surface as "inactive, and here is why" rather than as a mission dying
 * at spawn. The registry's visibility has no mission, hence no target: the
 * profile is offered as soon as SOME mission could be served, which is why the
 * grant is checked there without one — `secretReachesBackend`, not
 * `resolveSecretsFor`. With a `target` (a picker that knows its project), the
 * answer is the spawn's own selection, value dropped: the catalogue it filters
 * then offers nothing the spawn would refuse. Only a status ever leaves.
 */
export function probeProfileEnv(profile: BackendProfile, target?: SecretTarget): string | null {
  for (const key of profile.requiredEnv ?? []) {
    if (!process.env[key]) return `environment variable ${key} is not set`;
  }
  const refs = secretRefs(profile);
  if (refs.length === 0) return null;
  let rows: SecretWithGrants[];
  try {
    rows = listVault();
  } catch (err) {
    return `vault unavailable (${(err as Error).message})`;
  }
  for (const name of refs) {
    const rowsNamed = injectable(name, rows);
    if (rowsNamed.length === 0) return missingEntryReason(name);
    const candidates = target
      ? entriesFor(name, rowsNamed, profileTarget(profile, target))
      : rowsNamed.filter((row) => secretReachesBackend(row, profile.id)).sort(byRecency);
    if (candidates.length === 0) return target ? notGrantedReason(profile, name, rowsNamed) : unreachableReason(profile, name, rowsNamed);
    const opened = openFirstReadable(candidates);
    if ('code' in opened) return `vault entry ${name} cannot be read (${opened.code})`;
  }
  return null;
}

/** No entry under `name` can reach this backend at all. */
function unreachableReason(profile: BackendProfile, name: string, named: readonly SecretWithGrants[]): string {
  // Called once nothing reaches this backend: an unreserved entry then has no
  // grant, and a reserved one belongs to another backend.
  return named.some((row) => isBackendReserved(row) && !secretReachesBackend(row, profile.id))
    ? `vault entry ${name} is reserved for another backend`
    : noGrantReason(name);
}

/** Entries exist and reach this backend, but none for THIS mission. Three
 *  distinct fixes: grant it at all, reserve it here, or widen an audience. */
function notGrantedReason(profile: BackendProfile, name: string, named: readonly SecretWithGrants[]): string {
  if (!named.some((row) => secretReachesBackend(row, profile.id))) return unreachableReason(profile, name, named);
  return `vault entry ${name} is not granted to this mission`;
}

/** What a tester meets before setting any key: say where it goes. */
function missingEntryReason(name: string): string {
  return `vault entry ${name} does not exist (add it to the Secret Vault and grant it to \`global\`)`;
}

/** The one reason a tester will meet by simply forgetting a checkbox, so it
 *  says what to do rather than what failed. */
function noGrantReason(name: string): string {
  return `vault entry ${name} has no grant: no mission can receive it (grant it to \`global\`, or reserve it to this backend with \`backend:<id>\`)`;
}

/**
 * What a plugin's resolver handed back, copied ONCE and checked. Reasons never
 * quote it.
 *
 * The object belongs to the plugin: a getter or a proxy trap runs the plugin's
 * code on every read, and may throw next to the credential. So it is read here
 * only, under the same protection as the call, and what leaves is a plain copy
 * — a second read could answer something else than what was checked.
 */
function snapshotProvided(provided: unknown): Record<string, string> | string {
  try {
    if (typeof provided !== 'object' || provided === null) return 'credential resolver did not return an object';
    const copy: Record<string, string> = {};
    for (const key of Object.keys(provided)) {
      const value: unknown = (provided as Record<string, unknown>)[key];
      if (typeof value !== 'string') return `credential resolver returned a non-string ${key}`;
      copy[key] = value;
    }
    return copy;
  } catch {
    return resolverFailure();
  }
}

/** Nothing of the plugin's error is relayed, `name` no more than `message`:
 *  both were written next to the credential and nothing guarantees they do
 *  not quote it. */
function resolverFailure(): string {
  // Written by the product, so it is safe to show — and it says what a user can
  // act on. The commonest cause of a resolver that throws is an account that
  // has no connection to the backend.
  return RESOLVER_FAILED;
}

/** The only wording a plugin's failing resolver ever leaves behind. */
export const RESOLVER_FAILED =
  'credential resolver failed: check that this account has a connection to the backend (Settings › Secrets › Connections)';

/**
 * Same question as `probeProfileEnv`, for a plugin's `env` function: call it,
 * drop what it returns, keep only whether it could answer. Synchronous when the
 * function is — a profile registered without its key is then inactive from the
 * very first read, not one tick later.
 */
export function probeResolver(resolver: EnvResolver): string | null | Promise<string | null> {
  // Cannot throw: as the success branch of the `then` below, a throw would
  // turn the verdict into a rejection.
  const verdict = (provided: unknown): string | null => {
    const checked = snapshotProvided(provided);
    return typeof checked === 'string' ? checked : null;
  };
  try {
    // No mission behind a visibility check: the plugin must not require a user.
    const provided: unknown = resolver(probeLaunchContext());
    // Recognise a promise the way the spawn's `await` does — by a callable
    // `then`, not `instanceof`: a proxy's `getPrototypeOf` trap would refuse
    // here an object the spawn accepts. Reading `then` runs the plugin's code
    // (a getter, a trap); a throw lands in the catch below, as `await` would
    // reject. `then` is read ONCE, like `await` does: a second read could
    // answer something else than the spawn will see.
    const then: unknown = (typeof provided === 'object' && provided !== null) || typeof provided === 'function'
      ? (provided as { then?: unknown }).then
      : undefined;
    if (typeof then === 'function') return adoptThenable(provided, then as (...args: unknown[]) => unknown).then(verdict, resolverFailure);
    return verdict(provided);
  } catch {
    return resolverFailure();
  }
}

/**
 * What `await provided` does with a `then` already read: call it on a later
 * tick with `provided` as receiver and a resolve/reject pair that only the
 * first call settles, a throw after settling being ignored. The Promise
 * constructor gives exactly that pair and that catch.
 */
function adoptThenable(provided: unknown, then: (...args: unknown[]) => unknown): Promise<unknown> {
  return Promise.resolve().then(() => new Promise<unknown>((resolve, reject) => {
    Reflect.apply(then, provided, [resolve, reject]);
  }));
}

export type ResolvedEnv = {
  env: Record<string, string>;
  /** Vault entries that entered `env`, for the access journal. */
  injected: InjectedSecret[];
};

/**
 * The env of `profile` for ONE spawn. Order unchanged from the cached version
 * it replaces: `env` first, then `envFrom` overrides when its source variable
 * exists and is non-empty. `launch` is handed to the plugin's resolver as is.
 */
export async function resolveProfileEnv(
  profile: BackendProfile,
  resolver: EnvResolver | undefined,
  target: SecretTarget = {},
  launch: BackendLaunchContext = probeLaunchContext(),
): Promise<ResolvedEnv> {
  for (const key of profile.requiredEnv ?? []) {
    if (!process.env[key]) throw new ProfileEnvError(profile.id, `environment variable ${key} is not set`);
  }
  const env: Record<string, string> = {};
  const injected: InjectedSecret[] = [];

  if (resolver) {
    let provided: unknown;
    try {
      provided = await resolver(launch);
    } catch {
      throw new ProfileEnvError(profile.id, resolverFailure());
    }
    const checked = snapshotProvided(provided);
    if (typeof checked === 'string') throw new ProfileEnvError(profile.id, checked);
    Object.assign(env, checked);
  }

  let rows: SecretWithGrants[] | undefined;
  for (const [key, value] of Object.entries(profile.env ?? {})) {
    if (!isSecretRef(value)) { env[key] = value; continue; }
    // Filled below from the daemon's environment.
    if (envSupplies(profile, key)) continue;
    try {
      rows ??= listVault();
    } catch (err) {
      throw new ProfileEnvError(profile.id, `vault unavailable (${(err as Error).message})`);
    }
    // Re-checked here at every spawn, whatever the registry cached: the
    // catalogue's answer is a status, this is the decision.
    const entries = entriesFor(value.secret, rows, profileTarget(profile, target));
    if (entries.length === 0) {
      const named = injectable(value.secret, rows);
      // Distinct situations, distinct fixes: create the entry, grant it at
      // all, reserve it to this backend, or widen a grant that names another
      // scope.
      const reason = named.length === 0
        ? missingEntryReason(value.secret)
        : notGrantedReason(profile, value.secret, named);
      throw new ProfileEnvError(profile.id, reason);
    }
    const opened = openFirstReadable(entries);
    if ('code' in opened) throw new ProfileEnvError(profile.id, `vault entry ${value.secret} cannot be read (${opened.code})`);
    env[key] = opened.value;
    injected.push({ id: opened.row.id, name: opened.row.name });
  }

  for (const [childKey, sourceKey] of Object.entries(profile.envFrom ?? {})) {
    const v = process.env[sourceKey];
    if (v) env[childKey] = v;
  }
  return { env, injected };
}
