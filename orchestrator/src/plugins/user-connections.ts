/**
 * Per-user plugin connections (apiVersion 7): a URL, a config validated by the
 * plugin's schema and secrets in the vault, owned by ONE account and with no
 * messaging transport. The messaging connections of `integration-service.ts`
 * are a different table and keep their behaviour.
 *
 * Three rules hold everywhere in this file:
 *  - the owner comes from the authenticated caller, never from a payload;
 *  - a secret value goes into a sealed `plugin_kv` row and only comes out for
 *    the plugin, through `secret()` — no listing, route or error carries it;
 *  - a connection's origin is reachable by `ctx.fetch` only once approved, and
 *    then only through the SSRF guard of `net-guard.ts`.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { runPluginRequest } from './als.js';
import { integrationRegistries, integrationRequestIdentity } from './integration-host.js';
import { integrationJson, parseIntegrationValue } from './integration-primitives.js';
import { assertAddressAllowed, assertUrlShape, DestinationRefusedError, guardedFetch, type AddressLookup, type DestinationPolicy } from './net-guard.js';
import type {
  PluginConnectionApproval, PluginConnectionTestResult, PluginJsonObject, PluginUserConnection,
} from './integration-types.js';

export class UserConnectionError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'UserConnectionError'; }
}

/** What the daemon keeps; `approvedBy` is for the admin view, not the plugin. */
export type StoredUserConnection = PluginUserConnection & {
  readonly origin: string;
  readonly approvedBy: string | null;
  readonly approvedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type UserConnectionInput = {
  type: string;
  label: string;
  url: string;
  allowPrivateNetwork?: boolean;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
};
export type UserConnectionPatch = {
  label?: string;
  url?: string;
  allowPrivateNetwork?: boolean;
  config?: Record<string, unknown>;
  /** `null` removes a secret. */
  secrets?: Record<string, string | null>;
  enabled?: boolean;
};
/** The caller of a route: an account, and whether it administers the daemon. */
export type ConnectionActor = { userId: string; isAdmin: boolean };

export type UserConnectionHost = {
  approvalPolicy(): 'admin' | 'owner';
  /** Seal, read and drop a secret in `plugin_kv` under the vault envelope. */
  writeSecret(pluginId: string, key: string, value: string): void;
  readSecret(pluginId: string, key: string): string | undefined;
  deleteSecret(pluginId: string, key: string): void;
  /** The operator's `pluginPolicy.http.allow` still applies, on its own terms. */
  allowlisted(pluginId: string, url: URL): boolean;
  lookup?: AddressLookup;
};

const SECRET_PREFIX = '@connections/';
const secretKey = (id: string, name: string) => `${SECRET_PREFIX}${id}/${name}`;

export class UserConnectionStore {
  constructor(readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_connections (
        id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, origin TEXT NOT NULL,
        approval TEXT NOT NULL, enabled INTEGER NOT NULL, revision INTEGER NOT NULL, definition TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS user_connection_owners ON user_connections(owner_user_id, plugin_id);
      CREATE INDEX IF NOT EXISTS user_connection_origins ON user_connections(plugin_id, origin, approval, enabled);
    `);
  }
  #rows(sql: string, ...args: unknown[]): StoredUserConnection[] {
    return (this.db.prepare(sql).all(...args) as { definition: string }[]).map((row) => JSON.parse(row.definition) as StoredUserConnection);
  }
  get(id: string): StoredUserConnection | undefined {
    return this.#rows('SELECT definition FROM user_connections WHERE id=?', id)[0];
  }
  ofOwner(ownerUserId: string): StoredUserConnection[] {
    return this.#rows('SELECT definition FROM user_connections WHERE owner_user_id=? ORDER BY rowid', ownerUserId);
  }
  all(): StoredUserConnection[] {
    return this.#rows('SELECT definition FROM user_connections ORDER BY rowid');
  }
  approvedAt(pluginId: string, origin: string): StoredUserConnection[] {
    return this.#rows("SELECT definition FROM user_connections WHERE plugin_id=? AND origin=? AND approval='approved' AND enabled=1", pluginId, origin);
  }
  insert(connection: StoredUserConnection): void {
    this.db.prepare('INSERT INTO user_connections VALUES (?,?,?,?,?,?,?,?)').run(
      connection.id, connection.pluginId, connection.identity.ownerUserId, connection.origin,
      connection.approval, connection.enabled ? 1 : 0, connection.revision, JSON.stringify(connection),
    );
  }
  /** Optimistic: a concurrent edit makes this one fail instead of being lost. */
  replace(connection: StoredUserConnection, previousRevision: number): void {
    const changed = this.db.prepare('UPDATE user_connections SET origin=?, approval=?, enabled=?, revision=?, definition=? WHERE id=? AND revision=?').run(
      connection.origin, connection.approval, connection.enabled ? 1 : 0, connection.revision, JSON.stringify(connection),
      connection.id, previousRevision,
    ).changes;
    if (!changed) throw new UserConnectionError(409, 'Connection changed; reload before updating');
  }
  delete(id: string): void { this.db.prepare('DELETE FROM user_connections WHERE id=?').run(id); }
  /**
   * The plugin is gone: nothing approved or deposited for it may serve the next
   * package under its id. The connection itself stays, it is the user's. A refusal
   * stays a refusal. Returns the connections this changed.
   */
  withdrawPlugin(pluginId: string): StoredUserConnection[] {
    return this.db.transaction(() => {
      const changed: StoredUserConnection[] = [];
      for (const old of this.#rows('SELECT definition FROM user_connections WHERE plugin_id=? ORDER BY rowid', pluginId)) {
        if (old.approval !== 'approved' && !old.secrets.length) continue;
        const next: StoredUserConnection = {
          ...old, approval: old.approval === 'approved' ? 'pending' : old.approval, approvedBy: null, approvedAt: null,
          secrets: [], revision: old.revision + 1, updatedAt: Date.now(),
        };
        this.replace(next, old.revision);
        changed.push(next);
      }
      return changed;
    })();
  }
}

/** Plugin-visible snapshot: no origin bookkeeping, no approver. */
export function publicUserConnection(connection: StoredUserConnection): PluginUserConnection {
  return {
    id: connection.id, pluginId: connection.pluginId, type: connection.type, identity: { ownerUserId: connection.identity.ownerUserId },
    label: connection.label, url: connection.url, allowPrivateNetwork: connection.allowPrivateNetwork, config: connection.config,
    secrets: [...connection.secrets], approval: connection.approval, enabled: connection.enabled, revision: connection.revision,
  };
}

/**
 * Checks that need no DNS, run when the URL is saved so an obvious refusal
 * shows in the form, not later in a plugin log. The real guard runs again on
 * every request, against the resolved addresses.
 */
export function normalizeConnectionUrl(raw: string, allowPrivateNetwork: boolean): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new UserConnectionError(400, 'Invalid URL'); }
  try {
    assertUrlShape(url);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) {
      const kind = assertAddressAllowed(host, { allowPrivateNetwork });
      if (url.protocol === 'http:' && kind !== 'loopback' && kind !== 'tailscale') throw new DestinationRefusedError('HTTPS is required outside loopback and Tailscale addresses');
    } else if (url.protocol === 'http:' && host !== 'localhost' && !host.endsWith('.ts.net')) {
      throw new DestinationRefusedError('HTTPS is required outside loopback and Tailscale addresses');
    }
    // A token pasted into the query would be shown in every listing and to the
    // approver: keys belong in the vault, the plugin adds its own parameters.
    if (url.search || url.hash || raw.includes('#')) throw new DestinationRefusedError('a connection URL has no query or fragment; put keys in the secrets');
  } catch (error) {
    if (error instanceof DestinationRefusedError) throw new UserConnectionError(400, error.message);
    throw error;
  }
  return url;
}

function typeLease(type: string) {
  const lease = integrationRegistries.connectionTypes.get(type);
  if (!lease) throw new UserConnectionError(404, 'Connection type unavailable');
  return lease;
}

export class UserConnectionService {
  constructor(readonly store: UserConnectionStore, readonly host: UserConnectionHost) {}

  /**
   * May this account use the plugin at all? Same rule as every integration
   * callback. Attended: every caller here is the account's own request (it
   * writes or tests its connection), so the plugin code it runs answers to it.
   */
  #ownerIdentity(pluginId: string, ownerUserId: string) {
    try { return integrationRequestIdentity(pluginId, ownerUserId, { attended: true }); }
    catch { throw new UserConnectionError(403, 'This account cannot use the plugin'); }
  }
  #usable(pluginId: string, ownerUserId: string): boolean {
    try { integrationRequestIdentity(pluginId, ownerUserId); return true; } catch { return false; }
  }
  /**
   * The connection `id` for `actor`. Another account's connection answers like a
   * missing one — except for an administrator where the caller says an
   * administrator may manage it (`byAdmin`): editing or removing someone's
   * gateway, never probing it with their secrets.
   */
  #own(actor: ConnectionActor, id: string, byAdmin = false): StoredUserConnection {
    const connection = this.store.get(id);
    if (!connection) throw new UserConnectionError(404, 'Connection not found');
    if (connection.identity.ownerUserId === actor.userId || (byAdmin && actor.isAdmin)) return connection;
    throw new UserConnectionError(404, 'Connection not found');
  }
  #approval(actor: ConnectionActor): { approval: PluginConnectionApproval; approvedBy: string | null; approvedAt: number | null } {
    return actor.isAdmin || this.host.approvalPolicy() === 'owner'
      ? { approval: 'approved', approvedBy: actor.userId, approvedAt: Date.now() }
      : { approval: 'pending', approvedBy: null, approvedAt: null };
  }
  async #config(type: string, ownerUserId: string, pluginId: string, value: unknown): Promise<PluginJsonObject> {
    const lease = typeLease(type);
    const identity = this.#ownerIdentity(pluginId, ownerUserId);
    try {
      const parsed = await lease.invoke((definition) => runPluginRequest(identity, () => parseIntegrationValue(definition.configSchema, value ?? {})));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return parsed;
    } catch { throw new UserConnectionError(400, 'Invalid connection configuration'); }
  }
  #secretNames(type: string, secrets: Record<string, string | null>, existing: readonly string[], creating: boolean): string[] {
    const declared = typeLease(type).definition.secrets ?? [];
    const names = new Set(existing);
    for (const [name, value] of Object.entries(secrets)) {
      if (!declared.some((field) => field.name === name)) throw new UserConnectionError(400, 'Unknown secret for this connection type');
      if (value === null) names.delete(name); else names.add(name);
    }
    if (creating || Object.keys(secrets).length) {
      for (const field of declared) if (field.required && !names.has(field.name)) throw new UserConnectionError(400, `Secret ${field.name} is required`);
    }
    return [...names].sort();
  }

  /** Types of the plugins this account may use. */
  types(actor: ConnectionActor) {
    return integrationRegistries.connectionTypes.list()
      .filter((lease) => actor.isAdmin || this.#usable(lease.pluginId, actor.userId))
      .map((lease) => ({
        id: lease.id, pluginId: lease.pluginId, label: lease.definition.label, description: lease.definition.description ?? null,
        fields: lease.definition.fields ?? [], secrets: lease.definition.secrets ?? [], customTest: typeof lease.definition.test === 'function',
      }));
  }
  listOwn(actor: ConnectionActor): StoredUserConnection[] { return this.store.ofOwner(actor.userId); }
  listAll(): StoredUserConnection[] { return this.store.all(); }
  /** Who owns connection `id`, or null. For the audit trail of an admin's change. */
  ownerOf(id: string): string | null { return this.store.get(id)?.identity.ownerUserId ?? null; }

  async create(actor: ConnectionActor, input: UserConnectionInput): Promise<StoredUserConnection> {
    const lease = typeLease(input.type);
    this.#ownerIdentity(lease.pluginId, actor.userId);
    const allowPrivateNetwork = input.allowPrivateNetwork === true;
    const url = normalizeConnectionUrl(input.url, allowPrivateNetwork);
    const config = await this.#config(lease.id, actor.userId, lease.pluginId, input.config);
    const secrets = input.secrets ?? {};
    const names = this.#secretNames(lease.id, secrets, [], true);
    const now = Date.now();
    const connection: StoredUserConnection = {
      id: randomUUID(), pluginId: lease.pluginId, type: lease.id, identity: { ownerUserId: actor.userId },
      label: input.label.trim(), url: url.href, origin: url.origin, allowPrivateNetwork, config, secrets: names,
      enabled: true, revision: 1, createdAt: now, updatedAt: now, ...this.#approval(actor),
    };
    for (const [name, value] of Object.entries(secrets)) this.host.writeSecret(connection.pluginId, secretKey(connection.id, name), value);
    this.store.insert(connection);
    return connection;
  }

  async update(actor: ConnectionActor, id: string, patch: UserConnectionPatch): Promise<StoredUserConnection> {
    const old = this.#own(actor, id, true);
    // The connection belongs to its owner: what the plugin validates and what it
    // may reach are the owner's, whoever is editing it.
    const ownerUserId = old.identity.ownerUserId;
    this.#ownerIdentity(old.pluginId, ownerUserId);
    const allowPrivateNetwork = patch.allowPrivateNetwork ?? old.allowPrivateNetwork;
    const url = normalizeConnectionUrl(patch.url ?? old.url, allowPrivateNetwork);
    const config = patch.config === undefined ? old.config : await this.#config(old.type, ownerUserId, old.pluginId, patch.config);
    const secrets = patch.secrets ?? {};
    const names = Object.keys(secrets).length ? this.#secretNames(old.type, secrets, old.secrets, false) : [...old.secrets];
    // What an approver looked at is the origin and the private-network flag:
    // changing either is a new request.
    const reopened = url.origin !== old.origin || allowPrivateNetwork !== old.allowPrivateNetwork;
    const next: StoredUserConnection = {
      ...old, label: patch.label?.trim() ?? old.label, url: url.href, origin: url.origin, allowPrivateNetwork, config, secrets: names,
      enabled: patch.enabled ?? old.enabled, revision: old.revision + 1, updatedAt: Date.now(),
      ...(reopened ? this.#approval(actor) : {}),
    };
    this.store.replace(next, old.revision);
    for (const [name, value] of Object.entries(secrets)) {
      if (value === null) this.host.deleteSecret(old.pluginId, secretKey(id, name));
      else this.host.writeSecret(old.pluginId, secretKey(id, name), value);
    }
    return next;
  }

  remove(actor: ConnectionActor, id: string): void {
    const connection = this.#own(actor, id, true);
    this.store.delete(id);
    for (const name of connection.secrets) this.host.deleteSecret(connection.pluginId, secretKey(id, name));
  }

  /** Admin decision, or the owner's when the operator delegated approval. */
  decide(actor: ConnectionActor, id: string, approval: 'approved' | 'rejected'): StoredUserConnection {
    const old = this.store.get(id);
    const own = old?.identity.ownerUserId === actor.userId;
    if (!old || (!actor.isAdmin && !own)) throw new UserConnectionError(404, 'Connection not found');
    if (!actor.isAdmin && (approval !== 'approved' || this.host.approvalPolicy() !== 'owner')) throw new UserConnectionError(403, 'An administrator approves this connection');
    const next: StoredUserConnection = {
      ...old, approval, approvedBy: approval === 'approved' ? actor.userId : null, approvedAt: approval === 'approved' ? Date.now() : null,
      revision: old.revision + 1, updatedAt: Date.now(),
    };
    this.store.replace(next, old.revision);
    return next;
  }

  async test(actor: ConnectionActor, id: string, signal?: AbortSignal): Promise<PluginConnectionTestResult & { status?: number }> {
    const connection = this.#own(actor, id);
    // Before approval the URL is only a request: probing it would hand an
    // unapproved user the daemon's network position.
    if (connection.approval !== 'approved' || !connection.enabled) throw new UserConnectionError(409, 'Connection is not approved and enabled');
    const lease = typeLease(connection.type);
    const identity = this.#ownerIdentity(connection.pluginId, actor.userId);
    const policy: DestinationPolicy = { allowPrivateNetwork: connection.allowPrivateNetwork };
    const sameOrigin = (url: URL) => {
      if (url.origin !== connection.origin) throw new DestinationRefusedError('a test stays on its connection origin');
      return policy;
    };
    const fetch: typeof globalThis.fetch = (input, init) => guardedFetch(input, init, { destination: sameOrigin, lookup: this.host.lookup });
    const revealed = new Set<string>();
    try {
      if (!lease.definition.test) {
        const response = await fetch(connection.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]) });
        await response.body?.cancel();
        return { ok: response.status < 500, status: response.status };
      }
      const result = await lease.invoke((definition, callSignal) => runPluginRequest(identity, () => definition.test!({
        signal: callSignal, identity: { ownerUserId: actor.userId }, connection: publicUserConnection(connection), fetch,
        secret: async (name) => {
          const value = this.secret(connection.pluginId, actor.userId, connection.id, name);
          if (value) revealed.add(value);
          return value;
        },
      })), { signal });
      const value = integrationJson(result) as { ok?: unknown; message?: unknown } | null;
      if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean') return { ok: false, message: 'The plugin returned no test result' };
      const message = typeof value.message === 'string' ? value.message.slice(0, 500) : undefined;
      // A message that echoes a credential is dropped, not shown to the browser.
      return { ok: value.ok, ...(message && ![...revealed].some((secret) => message.includes(secret)) ? { message } : {}) };
    } catch (error) {
      return { ok: false, message: error instanceof DestinationRefusedError ? error.message : 'Unreachable or refused' };
    }
  }

  // ── plugin side ────────────────────────────────────────────────────────────

  forUser(pluginId: string, ownerUserId: string): PluginUserConnection[] {
    this.#ownerIdentity(pluginId, ownerUserId);
    return this.store.ofOwner(ownerUserId).filter((connection) => connection.pluginId === pluginId).map(publicUserConnection);
  }

  secret(pluginId: string, ownerUserId: string, id: string, name: string): string | undefined {
    const connection = this.store.get(id);
    if (!connection || connection.pluginId !== pluginId || connection.identity.ownerUserId !== ownerUserId) return undefined;
    if (connection.approval !== 'approved' || !connection.enabled || !connection.secrets.includes(name)) return undefined;
    if (!this.#usable(pluginId, ownerUserId)) return undefined;
    return this.host.readSecret(pluginId, secretKey(id, name));
  }

  /** The policy of an approved destination of this plugin, if one matches the origin. */
  destination(pluginId: string, url: URL): DestinationPolicy | undefined {
    const live = this.store.approvedAt(pluginId, url.origin).filter((connection) => this.#usable(pluginId, connection.identity.ownerUserId));
    if (!live.length) return undefined;
    return { allowPrivateNetwork: live.some((connection) => connection.allowPrivateNetwork) };
  }

  /**
   * `ctx.fetch` towards an approved destination. Every redirect hop must be
   * an approved destination too, or an operator-allowlisted host reached
   * under the strict policy.
   */
  fetch(pluginId: string, input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> {
    return guardedFetch(input, init, {
      lookup: this.host.lookup,
      destination: (url) => {
        const approved = this.destination(pluginId, url);
        if (approved) return approved;
        if (this.host.allowlisted(pluginId, url)) return { allowPrivateNetwork: false };
        throw new DestinationRefusedError(`host ${url.hostname} is neither an approved connection nor allowed by pluginPolicy.http`);
      },
    });
  }
}

let current: UserConnectionService | undefined;
export function userConnectionService(): UserConnectionService {
  if (!current) throw new Error('User connection runtime unavailable');
  return current;
}
/** `undefined` when the runtime is not started (CLI, tests without a daemon). */
export function maybeUserConnectionService(): UserConnectionService | undefined { return current; }
export function startUserConnections(db: Database.Database, host: UserConnectionHost): { service: UserConnectionService; stop: () => void } {
  if (current) throw new Error('User connection runtime already started');
  const service = new UserConnectionService(new UserConnectionStore(db), host);
  current = service;
  return { service, stop: () => { if (current === service) current = undefined; } };
}
