/**
 * `ctx.secrets`.
 *
 * Extracted verbatim from `plugins/context.ts`, which re-exports it: the public
 * contract lives in leaf modules so `@rooks/sdk` can name it without the
 * implementation (TODO #512, option B).
 */

// Moved from `secrets/broker.ts`, which re-exports it (TODO #512, volet 3).
export interface BrokerHttpResult {
  status: number;
  /** Response body, with any occurrence of the value replaced by `***`. */
  body: string;
  /** Which host was actually called — so the agent can tell where it landed. */
  host: string;
}

/**
 * Read access to the secrets vault. Asynchronous although the local provider is
 * synchronous: an external provider (SECRETS-VAULT.md §3.2, Doppler, Vault)
 * would need the network, and widening the signature later would mean a new
 * `apiVersion`.
 */
export type PluginSecrets = {
  /**
   * The value granted to this plugin under `name`, or `undefined` when no grant
   * matches. Only a grant that names the plugin (`agent:plugin:<id>`) matches:
   * a `global` one is meant for agents and does not reach plugins. A `broker`
   * secret is never returned: its value does not leave the daemon, by name or
   * otherwise.
   */
  get(name: string): Promise<string | undefined>;
  /**
   * API 10, `secrets:list`: names, modes and grants of the vault, never a
   * value. A request needs the `secrets:manage` right and sees all of it; a
   * job sees what this plugin deposited and what it was granted.
   */
  list(): Promise<PluginSecretInfo[]>;
  /**
   * API 10, `secrets:manage`. Creates a secret nobody else can read (no grant)
   * or, for a superadmin's request or a secret this plugin deposited, replaces
   * its value. Errors carry a `code` (`PluginAdminErrorCode`).
   */
  set(input: PluginSecretInput): Promise<PluginSecretInfo>;
  /**
   * API 10, `secrets:manage`, a superadmin's request only. `scope` is
   * `project:<slug>` or `agent:<name>`; never `global`, never `agent:plugin:*`,
   * never `backend:*` (a reservation is the operator's).
   */
  grant(name: string, scope: string): Promise<PluginSecretInfo>;
  /** API 10, `secrets:manage`, a superadmin's request only. Never `backend:*`:
   *  lifting a reservation would widen the key. */
  revoke(name: string, scope: string): Promise<PluginSecretInfo>;
  /**
   * API 10, `secrets:broker` and `http:outbound`. An HTTP call under a
   * brokered identity granted to `agent:plugin:<id>`: the target must be both
   * among the identity's hosts and in the operator's `pluginPolicy.http.allow`
   * (refusal reason `policy-denied`), redirects are returned, never followed,
   * the value never comes back, every call is journalled.
   */
  httpCall(request: PluginHttpCallInput): Promise<PluginHttpCallResult>;
};

export type PluginSecretInfo = {
  id: string;
  name: string;
  mode: 'inject' | 'broker';
  /** `global`, `project:<slug>` or `agent:<name>`. Empty = the daemon alone. */
  grants: string[];
  /** A value is stored. */
  configured: boolean;
  note: string | null;
  /** This plugin deposited it. */
  mine: boolean;
  createdAt: number;
  updatedAt: number;
};

export type PluginSecretInput = {
  /** An environment-variable name: `^[A-Z][A-Z0-9_]*$`. */
  name: string;
  value: string;
  note?: string;
  /** New secrets only. `broker` needs `brokerSpec`. */
  mode?: 'inject' | 'broker';
  brokerSpec?: unknown;
};

export type PluginHttpCallInput = {
  /** The secret NAME of a brokered identity. Never a value. */
  identity: string;
  /** Absolute path on the target host, starting with `/`. */
  path: string;
  method?: string;
  /** One of the hosts the identity allows; defaults to the first. */
  host?: string;
  headers?: Record<string, string>;
  body?: unknown;
};

export type PluginHttpCallResult = BrokerHttpResult;
