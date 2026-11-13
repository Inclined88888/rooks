/**
 * Scope resolution for the secrets vault (SECRETS-VAULT.md §5.2/§5.3).
 *
 * Pure by construction: no I/O, no decryption. It takes the identities stored in
 * `secrets` + `secret_grants` and answers "which secrets is this mission allowed
 * to receive". The value never passes through here — the caller decrypts at the
 * last moment, once it knows what it is entitled to.
 *
 * The reason this lives apart from `db.ts` is testability: the precedence rules
 * are the part that silently leaks a token when they are wrong, and they must be
 * exercisable without a database, a mission or a spawn.
 */

/**
 * Where a grant applies. `global` carries no reference; the others do.
 *
 * `backend` is not an audience like the three others but a RESERVATION (TODO
 * #531, decision 5-B): a secret that carries one reaches only the process of
 * that backend, and only for the missions its other grants admit. See
 * `secretScopeFor`.
 */
export type SecretScopeKind = 'global' | 'project' | 'agent' | 'backend';

/** `inject` enters the agent environment, `broker` never leaves the daemon (§6). */
export type SecretMode = 'inject' | 'broker';

export const SECRET_SCOPE_KINDS: readonly SecretScopeKind[] = Object.freeze(['global', 'project', 'agent', 'backend']);
export const SECRET_MODES: readonly SecretMode[] = Object.freeze(['inject', 'broker']);

/**
 * A secret name is an environment variable identifier (§3.6), so injection is a
 * plain assignment — no transformation, no mangling, nothing that could turn two
 * distinct secrets into the same variable.
 */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export function isValidSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

export function isSecretScopeKind(value: string): value is SecretScopeKind {
  return (SECRET_SCOPE_KINDS as readonly string[]).includes(value);
}

export function isSecretMode(value: string): value is SecretMode {
  return (SECRET_MODES as readonly string[]).includes(value);
}

export interface SecretGrant {
  scope_kind: SecretScopeKind;
  /** Project slug, agent name or backend id; `null` for `global`. */
  scope_ref: string | null;
}

/** What the resolver needs to know about a secret — never its value. */
export interface SecretIdentity {
  id: string;
  name: string;
  mode: SecretMode;
  grants: readonly SecretGrant[];
  /** Tie-breaker between two grants of equal specificity; absent is treated as 0. */
  updated_at?: number;
}

/** The mission asking. Every field may be absent (a mission with no project). */
export interface SecretTarget {
  agent?: string | null;
  project?: string | null;
  /**
   * The backend whose OWN process the value would enter — set only by the
   * resolution of a backend profile's credentials (`backends/credentials.ts`),
   * from the profile itself, never from a caller. Absent for the vault slice
   * every trusted mission receives, for a plugin and for the broker: none of
   * them is a backend's process, so a reserved secret never answers them.
   */
  backend?: string | null;
}

export interface ResolvedSecret {
  id: string;
  name: string;
  mode: SecretMode;
  /** The scope that won — kept so the access journal (§8) can record *why*. */
  scope: SecretScopeKind;
}

/**
 * Specificity of a scope. Same shape as the `env > config > db > default` chain
 * in force everywhere in Rooks: the most specific wins.
 */
const SCOPE_RANK: Record<SecretScopeKind, number> = { agent: 4, project: 3, backend: 2, global: 1 };

/** Whether `secret` is reserved to one or more backends (5-B). */
export function isBackendReserved(secret: Pick<SecretIdentity, 'grants'>): boolean {
  return secret.grants.some((grant) => grant.scope_kind === 'backend');
}

/**
 * Whether `secret` may enter the process of `backendId` for SOME mission —
 * the target-less question a profile's visibility asks. A reserved secret
 * answers only its backends; any other answers whoever its grants name, and an
 * entry with no grant belongs to the daemon alone (§5.2).
 */
export function secretReachesBackend(secret: Pick<SecretIdentity, 'grants'>, backendId: string): boolean {
  if (isBackendReserved(secret)) {
    return secret.grants.some((grant) => grant.scope_kind === 'backend' && !!grant.scope_ref && grant.scope_ref === backendId);
  }
  return secret.grants.some((grant) => grant.scope_kind === 'global' || !!grant.scope_ref);
}

/**
 * The scope that grants access to `target`, or `null` if none does.
 *
 * A secret with NO grant returns `null` for every target: it belongs to the
 * daemon alone (§5.2). That is the default, and it is deliberately the one that
 * falls out of an empty list rather than requiring an explicit deny.
 *
 * A secret RESERVED to a backend (`backend:<id>`, TODO #531 decision 5-B) is the
 * one exception to "grants add up": its reservation and its other grants are an
 * INTERSECTION. It answers only a target that names one of its backends — so
 * never the vault slice, a plugin or the broker — and then only the missions
 * its audience grants (`global`, `project`, `agent`) admit; with no audience
 * grant at all, every mission of that backend. A project grant on a key that
 * is not reserved would still reach every other backend the project runs.
 */
export function secretScopeFor(secret: SecretIdentity, target: SecretTarget): SecretScopeKind | null {
  const reserved = isBackendReserved(secret);
  if (reserved) {
    const backend = target.backend;
    if (!backend || !secret.grants.some((grant) => grant.scope_kind === 'backend' && grant.scope_ref === backend)) return null;
  }
  let best: SecretScopeKind | null = null;
  let audience = false;
  for (const grant of secret.grants) {
    if (grant.scope_kind === 'backend') continue;
    audience = true;
    if (!grantMatches(grant, target)) continue;
    if (best === null || SCOPE_RANK[grant.scope_kind] > SCOPE_RANK[best]) best = grant.scope_kind;
  }
  if (!reserved) return best;
  // Reserved and open to every mission of the backend: ranked as the backend,
  // above an unreserved `global` entry of the same name.
  if (!audience || best === 'global') return 'backend';
  return best;
}

/**
 * The prefix of the address a plugin presents to the resolver
 * (`secrets/plugins.ts`). No mission agent can carry it: an agent name is a
 * directory of `~/.rooks/agents/` and never contains `:`.
 */
export const PLUGIN_AGENT_PREFIX = 'plugin:';

function isPluginTarget(target: SecretTarget): boolean {
  return !!target.agent && target.agent.startsWith(PLUGIN_AGENT_PREFIX);
}

function grantMatches(grant: SecretGrant, target: SecretTarget): boolean {
  // `global` means "every agent", and was written for missions. A plugin is
  // reached only by a grant that names it (TODO #531, decision 1-B): otherwise
  // installing any plugin holding `secrets:read` would hand it every key
  // shared with the agents.
  if (grant.scope_kind === 'global') return !isPluginTarget(target);
  // A reservation is not an audience: `secretScopeFor` checks it apart.
  if (grant.scope_kind === 'backend') return false;
  // An empty reference would match "any project" by accident: a grant that names
  // nothing grants nothing.
  if (!grant.scope_ref) return false;
  if (grant.scope_kind === 'project') return !!target.project && grant.scope_ref === target.project;
  return !!target.agent && grant.scope_ref === target.agent;
}

/**
 * The secrets injectable into a mission run by `agent` on `project`.
 *
 * Two filters, both structural rather than configurable:
 *  - mode `broker` is excluded — its value never enters an environment (§6.2),
 *    grant or no grant;
 *  - a name collision is settled by `agent > project > global` (§5.3), then by
 *    the most recent write, then by id so the outcome is deterministic.
 */
export function resolveSecretsFor(
  input: SecretTarget & { secrets: readonly SecretIdentity[] },
): ResolvedSecret[] {
  const target: SecretTarget = { agent: input.agent, project: input.project, backend: input.backend };
  const winners = new Map<string, Candidate>();

  for (const secret of input.secrets) {
    if (secret.mode !== 'inject') continue;
    if (!isValidSecretName(secret.name)) continue; // defensive: a legacy row must not become a variable
    const scope = secretScopeFor(secret, target);
    if (!scope) continue;

    const candidate = candidateOf(secret, scope);
    const current = winners.get(secret.name);
    if (!current || beats(candidate, current)) winners.set(secret.name, candidate);
  }

  return [...winners.values()]
    .map((w) => w.resolved)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The `broker` secret this mission may USE under the identity `name`, or `null`.
 *
 * The mirror image of `resolveSecretsFor`: same grants, same precedence, but the
 * opposite mode filter. Split in two rather than parameterised because the two
 * answers must never be produced by the same call — one populates an
 * environment, the other authorises the daemon to act; confusing them is exactly
 * how a broker value would end up injected (§6.2).
 */
export function resolveBrokerSecret(
  input: SecretTarget & { name: string; secrets: readonly SecretIdentity[] },
): ResolvedSecret | null {
  // No `backend`, whatever the caller passed: the daemon acting on a key is not
  // a backend's process, so a reserved entry is never brokered (5-B).
  const target: SecretTarget = { agent: input.agent, project: input.project };
  let best: Candidate | null = null;

  for (const secret of input.secrets) {
    if (secret.mode !== 'broker' || secret.name !== input.name) continue;
    const scope = secretScopeFor(secret, target);
    if (!scope) continue;
    const candidate = candidateOf(secret, scope);
    if (!best || beats(candidate, best)) best = candidate;
  }

  return best?.resolved ?? null;
}

type Candidate = { resolved: ResolvedSecret; updated_at: number; reserved: boolean };

function candidateOf(secret: SecretIdentity, scope: SecretScopeKind): Candidate {
  return {
    resolved: { id: secret.id, name: secret.name, mode: secret.mode, scope },
    updated_at: secret.updated_at ?? 0,
    reserved: isBackendReserved(secret),
  };
}

function beats(a: Candidate, b: Candidate): boolean {
  const rank = SCOPE_RANK[a.resolved.scope] - SCOPE_RANK[b.resolved.scope];
  if (rank !== 0) return rank > 0;
  // Same audience: the entry reserved to this backend is the more specific one.
  if (a.reserved !== b.reserved) return a.reserved;
  if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at;
  return a.resolved.id < b.resolved.id;
}
