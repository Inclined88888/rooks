/** Public plugin types, extracted from the host implementations (TODO #512). */

// Moved from `plugins-bundled/backends/account-routes.ts`, which re-exports it (TODO #512, volet 3).
export type AccountState = 'active' | 'cooldown' | 'reauth';

export type PluginAccountUser = {
  id: string;
  email: string;
  name: string;
  status: 'active' | 'disabled' | 'invited';
  isSuperadmin: boolean;
  createdAt: number;
  lastLoginAt: number | null;
};

export type PluginBackendAccount = {
  id: string;
  /** What `agents` and tasks name: `<backend>@<account>`. */
  instance: string;
  backend: string;
  name: string;
  ownerUserId: string | null;
  state: AccountState;
  /** Accounts the owner shared it with. */
  grantedTo: string[];
};

/** An account created by the account provider, as the core stored it. */
export type PluginProvisionedAccount = {
  id: string;
  email: string;
  name: string;
  status: 'active' | 'invited';
};

export type PluginProvisionInput = {
  email: string;
  name: string;
  /** Hashed by the core; the plugin never handles a password hash. At least 8 characters. */
  password: string;
  /** `active` (default) or `invited`. */
  status?: 'active' | 'invited';
};

/** An account as the account provider reads it: never a credential. */
export type PluginProviderAccount = {
  id: string;
  email: string;
  name: string;
  status: 'active' | 'disabled' | 'invited';
  isSuperadmin: boolean;
  createdAt: number;
  lastLoginAt: number | null;
};

/**
 * What the account provider may change on an account that is not a superadmin.
 * `password` is hashed by the core and closes the account's other sessions;
 * `status: 'disabled'` closes them all; `active` re-checks the licence.
 */
export type PluginProviderAccountPatch = {
  name?: string;
  password?: string;
  status?: 'active' | 'disabled';
};

export type PluginAccountChange = {
  userId: string;
  status: 'active' | 'disabled' | 'invited';
  previous: 'active' | 'disabled' | 'invited';
};

/** The core's former account tables, which the multi-user plugin migrates into its own database. */
export type PluginLegacyAccountTable =
  | 'roles' | 'role_permissions' | 'user_roles' | 'groups' | 'group_roles' | 'user_groups' | 'invitations';

/** The request of a plugin route, as far as opening a session needs it. */
export type PluginSessionRequest = { header(name: string): string | undefined };
/** The response of a plugin route, as far as opening a session needs it. */
export type PluginSessionResponse = { setHeader(name: string, value: string | number | readonly string[]): unknown };

/**
 * API 15 — the account provider (`ctx.accountProvider`, sensitive permission
 * `accounts:provision`, signed or bundled plugins only). The way an account other
 * than the first superadmin comes to exist: the core runs the creation (licence
 * quota, unique e-mail, its own password hash) and opens the session (its own
 * cookie). One plugin at a time holds it: the first to call it, until unloaded.
 */
export type PluginAccountProvider = {
  /** Creates an account. Never a superadmin. Refused beyond what the licence allows. */
  provision(input: PluginProvisionInput): PluginProvisionedAccount;
  /** Every account of the install, superadmins included, oldest first. */
  list(): PluginProviderAccount[];
  get(userId: string): PluginProviderAccount | undefined;
  /** The e-mail is compared the way the core stores it: trimmed, lower case. */
  findByEmail(email: string): PluginProviderAccount | undefined;
  /** Changes an account that is not a superadmin; a superadmin is refused whole. */
  update(userId: string, patch: PluginProviderAccountPatch): PluginProviderAccount;
  /** Opens a browser session for an active account that is not a superadmin, as a login would. */
  openSession(userId: string, req: PluginSessionRequest, res: PluginSessionResponse): void;
  /**
   * Reads one of the core's former account tables, whole, to migrate it into the
   * plugin's own database: a closed list, read only, for the holder only. The rows
   * come from the file the core wrote them to when they left its schema; `[]` on
   * an install that never had them.
   */
  readLegacy(table: PluginLegacyAccountTable): Record<string, unknown>[];
  /**
   * Writes an audit line in the plugin's name (`plugin:<id>`), for the account of
   * the current request when there is one. An action and a target, never a value.
   */
  audit(action: string, target?: string | null): void;
  /** The latest lines of the install's audit log, newest first (1 to 1000, default 200). */
  auditLog(limit?: number): PluginAuditEntry[];
  /** Called when an account's status changes (disabled, enabled again). Returns the unsubscribe. */
  onAccountChanged(fn: (change: PluginAccountChange) => void): () => void;
};

/** One line of the install's audit log. `actor` names a non-human caller (`plugin:<id>`, `daemon`). */
export type PluginAuditEntry = {
  id: string;
  at: number;
  userId: string | null;
  actor: string | null;
  action: string;
  target: string | null;
};

/** A right the core checks somewhere, as a role editor offers it. */
export type PluginPermissionAction = {
  /** First segment of `permission`: how an editor groups the checkboxes. */
  domain: string;
  permission: string;
  label: string;
  /** Set only for a module that can be switched off: the editor cards it under that plugin. */
  pluginId?: string;
};

/** Every right of this install: the core's checks, then the surfaces and plugins that are active. */
export type PluginPermissionCatalog = {
  actions: PluginPermissionAction[];
  plugins: { id: string; name: string; kind: string[]; tier: string | null }[];
};

export type PluginPermissionSourceHandle = {
  /** Forgets the cached rights of one account, or of every account: call it after a role or a group changed. */
  invalidate(userId?: string): void;
};

/**
 * API 15 — the source of the accounts' rights (`ctx.permissionSource`, sensitive
 * permission `accounts:permissions-source`, signed plugins only). The core keeps
 * the evaluation; the source only answers "which rights does this account
 * hold", synchronously, from the plugin's own data. A source that throws grants
 * nothing. One source at a time; it is released when the plugin unloads.
 */
export type PluginPermissionSource = {
  register(fn: (userId: string) => readonly string[]): PluginPermissionSourceHandle;
  /** The rights a role may grant on this install, read live: a module switched off drops out. */
  catalog(): PluginPermissionCatalog;
};
