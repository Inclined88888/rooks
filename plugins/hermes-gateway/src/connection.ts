/**
 * The per-user connection to a Hermes gateway: one connection is one Hermes
 * profile (the gateway's default one, or `/p/<profile>/`, which has its own
 * key). Hermes lists no profiles to a client, so a user adds one connection
 * per profile they want in Rooks — and one per gateway, as many as they run.
 */
import type {
  BackendLaunchContext, PluginConnections, PluginConnectionTypeDefinition, PluginUserConnection,
} from '@rooks/sdk';
import { checkGateway, compareVersions, RECOMMENDED_VERSION, targetUrls, type Fetch, type GatewayTarget } from './gateway.js';

export const TYPE_NAME = 'gateway';
export const TYPE_VERSION = 1;
export const SECRET_KEY = 'apiKey';
/**
 * Model slugs of the backend. `hermes/<profile>` is a shared door: each account
 * that talks to the agent reaches its own connection serving that profile.
 * `hermes/<connectionId>/<profile>` pins one connection, so one account can use
 * several gateways exposing the same profile; such an agent serves the owner of
 * that connection only. A profile name never holds a `/`, which tells them apart.
 */
export const MODEL_PREFIX = 'hermes/';
export const DEFAULT_PROFILE = 'default';

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function qualifiedType(pluginId: string): string {
  return `${pluginId}:${TYPE_NAME}@${TYPE_VERSION}`;
}

/** A refusal the user can act on. Its message is safe to show: no key, no URL. */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Same contract as a Zod schema: the clean config, or a throw. */
export const configSchema = {
  parse(value: unknown): { profile?: string } {
    const object = record(value);
    if (!object) throw new Error('Expected an object');
    const { profile, ...rest } = object;
    if (Object.keys(rest).length > 0) throw new Error('Unknown field');
    if (profile === undefined || profile === null || profile === '') return {};
    if (typeof profile !== 'string') throw new Error('Invalid profile');
    const name = profile.trim();
    if (!name || name === DEFAULT_PROFILE) return {};
    if (!PROFILE_RE.test(name)) throw new Error('A profile name is letters, digits, ".", "_" or "-"');
    return { profile: name };
  },
};

/** The Hermes profile a connection reaches. */
export function connectionProfile(connection: Pick<PluginUserConnection, 'config'>): string {
  const profile = connection.config.profile;
  return typeof profile === 'string' && profile.trim() ? profile.trim() : DEFAULT_PROFILE;
}

/** What an agent's model asks for: a profile, through one pinned connection or any of the account's. */
export type ModelTarget = { profile: string; connectionId: string | null };

const CONNECTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/** `null` when the model names no profile (or is not a Hermes slug). */
export function parseModel(model: string | null | undefined): ModelTarget | null {
  if (!model || !model.startsWith(MODEL_PREFIX)) return null;
  const rest = model.slice(MODEL_PREFIX.length).trim();
  if (!rest) return null;
  const slash = rest.indexOf('/');
  if (slash < 0) return { profile: rest, connectionId: null };
  const connectionId = rest.slice(0, slash);
  const profile = rest.slice(slash + 1);
  // Anything else with a slash is no profile a connection can serve: kept whole,
  // it is refused as an unknown profile, as before pinned models existed.
  if (!CONNECTION_ID_RE.test(connectionId) || !PROFILE_RE.test(profile)) return { profile: rest, connectionId: null };
  return { profile, connectionId };
}

/** The Hermes profile an agent's model names; `null` when it names none. */
export function profileOfModel(model: string | null | undefined): string | null {
  return parseModel(model)?.profile ?? null;
}

/** The shared door: any account's connection serving `profile`. */
export function modelOfProfile(profile: string): string {
  return `${MODEL_PREFIX}${profile}`;
}

/** One connection, by its id (never its URL or key), for the profile it serves. */
export function modelOfConnection(connection: Pick<PluginUserConnection, 'id' | 'config'>): string {
  return `${MODEL_PREFIX}${connection.id}/${connectionProfile(connection)}`;
}

/** `X-Hermes-Session-Key`: one Hermes memory per Rooks account. */
export function sessionKeyFor(ownerUserId: string): string {
  return `rooks:${ownerUserId}`;
}

export function usable(connection: PluginUserConnection): boolean {
  return connection.enabled && connection.approval === 'approved';
}

export const NO_CONNECTION = 'No Hermes gateway is configured for your account: add one in Settings › Secrets › Connections.';
/** One message for a deleted connection and another account's: which one is never told. */
export const NOT_YOUR_CONNECTION = 'This Hermes agent is tied to one gateway connection, and your account has no such connection: '
  + 'it was deleted, or it belongs to another account. Use your own Hermes agents (Settings › Hermes Gateway › Add my Hermes agents to Rooks).';

/**
 * The connection a model routes to among the account's own (`mine`, of this
 * plugin's type), `null` when none is usable; refusals are `UserFacingError`s.
 * Shared door: the first usable one serving the profile (the default profile
 * first when the model names none). Pinned: that connection, or nothing.
 */
export function pickConnection(mine: readonly PluginUserConnection[], model: string | null | undefined): PluginUserConnection {
  const wanted = parseModel(model);
  if (wanted?.connectionId) {
    const pinned = mine.find((c) => c.id === wanted.connectionId);
    if (!pinned) throw new UserFacingError(NOT_YOUR_CONNECTION);
    const serves = connectionProfile(pinned);
    if (serves !== wanted.profile) {
      throw new UserFacingError(
        `Your Hermes gateway connection "${pinned.label}" now serves the profile "${serves}", not "${wanted.profile}": `
        + 'click "Add my Hermes agents to Rooks" in Settings › Hermes Gateway again.',
      );
    }
    if (!usable(pinned)) throw new UserFacingError(unusableReason(pinned));
    return pinned;
  }
  if (mine.length === 0) throw new UserFacingError(NO_CONNECTION);
  const profile = wanted?.profile ?? null;
  const candidates = profile ? mine.filter((c) => connectionProfile(c) === profile) : mine;
  if (candidates.length === 0) {
    throw new UserFacingError(`None of your Hermes gateway connections serves the profile "${profile}": add one with that profile in Settings › Secrets › Connections.`);
  }
  const live = candidates.filter(usable);
  // Without a profile in the model, the default profile first, then any.
  const pick = profile
    ? live[0]
    : live.find((c) => connectionProfile(c) === DEFAULT_PROFILE) ?? live[0];
  if (!pick) throw new UserFacingError(unusableReason(candidates[0]!));
  return pick;
}

function unusableReason(connection: PluginUserConnection): string {
  if (connection.approval === 'pending') {
    return 'Your Hermes gateway connection is waiting for an administrator to approve its address (Settings › Secrets › Connections).';
  }
  if (connection.approval === 'rejected') {
    return 'An administrator refused the address of your Hermes gateway connection (Settings › Secrets › Connections).';
  }
  return 'Your Hermes gateway connection is turned off (Settings › Secrets › Connections).';
}

/**
 * The gateway, profile and key for a mission: the connection of the account
 * that launched it, the one its agent's model names (`pickConnection`). Every
 * refusal is a `UserFacingError`, which `start()` shows in the mission's thread.
 */
export async function resolveTarget(
  connections: Pick<PluginConnections, 'forUser' | 'userSecret'>,
  typeId: string,
  launch: BackendLaunchContext | undefined,
  model: string | null | undefined,
): Promise<GatewayTarget> {
  if (!launch || launch.kind !== 'mission') {
    throw new UserFacingError('A Hermes gateway agent runs only in a mission, on behalf of the account that launched it.');
  }
  const owner = launch.ownerUserId;
  if (!owner || owner.startsWith('plugin:')) {
    throw new UserFacingError(
      'This mission was not launched by an account (an unassigned Kanban task, a routine or a plugin). '
      + 'A Hermes gateway agent uses the gateway of the account that launches it: start it from your account.',
    );
  }
  let mine: PluginUserConnection[];
  try {
    mine = (await connections.forUser(owner)).filter((c) => c.type === typeId);
  } catch {
    throw new UserFacingError('Your account is not allowed to use the Hermes Gateway plugin. Ask an administrator.');
  }
  const pick = pickConnection(mine, model);
  const key = await connections.userSecret(owner, pick.id, SECRET_KEY);
  if (!key) throw new UserFacingError('Your Hermes gateway connection has no API key: set it in Settings › Secrets › Connections.');
  const profile = connectionProfile(pick);
  const { root, base } = targetUrls(pick.url, profile);
  return { root, base, profile, key, sessionKey: sessionKeyFor(owner) };
}

/** The connection type users fill in, with its "Test" button. */
export function connectionType(): PluginConnectionTypeDefinition {
  return {
    name: TYPE_NAME,
    version: TYPE_VERSION,
    label: 'Hermes Gateway',
    description: 'A Hermes gateway API server (Hermes 0.21.0 or later). One connection per Hermes profile; a profile has its own key.',
    configSchema,
    fields: [{ key: 'profile', label: 'Hermes profile (empty: default)', placeholder: DEFAULT_PROFILE }],
    secrets: [{ name: SECRET_KEY, label: 'API server key (API_SERVER_KEY)', required: true }],
    timeoutMs: 15_000,
    async test(context) {
      const key = await context.secret(SECRET_KEY);
      if (!key) return { ok: false, message: 'Set the API server key first.' };
      const profile = connectionProfile(context.connection);
      const { root, base } = targetUrls(context.connection.url, profile);
      const fetch: Fetch = (input, init) => context.fetch(input, init);
      const result = await checkGateway(fetch, { root, base, profile, key, sessionKey: null }, context.signal);
      if (!result.ok) return result;
      const old = result.version ? compareVersions(result.version, RECOMMENDED_VERSION) : null;
      const version = result.version ? `Hermes ${result.version}` : 'Hermes (version not reported)';
      const advice = old !== null && old < 0 ? ` Update to ${RECOMMENDED_VERSION} or later so a cut stream can resume.` : '';
      return { ok: true, message: `${version}, profile "${result.model ?? profile}".${advice}` };
    },
  };
}
