/**
 * Subscription accounts of a backend (TODO #52): several `claude` or `codex`
 * sign-ins on one machine, each in its own config directory, each reachable as
 * a backend instance (`instance-id.ts`).
 *
 * A row holds no secret: the CLI keeps its sign-in in the account directory
 * (`CLAUDE_CONFIG_DIR`, the `auth.json` a mission's `CODEX_HOME` links to).
 * `owner_user_id` NULL = an instance account, set up by the superadmin for the
 * missions nobody owns (cron, system, plugin jobs).
 *
 * Who may use an account: its owner, the users it is granted to, and the
 * superadmin. The read filter is a WHERE built here, like `ownerSql` for the
 * owned tables (`docs/MULTI-USER.md` §5), so a route cannot forget it.
 */
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../db.js';
import { TIMON_HOME } from '../paths.js';
import { ensurePrivateDir } from '../host/private-dir.js';
import { ACCOUNT_ID_RE, accountInstanceId } from './instance-id.js';
import type { DbViewer } from '../users/owned.js';

db.exec(`
CREATE TABLE IF NOT EXISTS backend_accounts (
  id TEXT PRIMARY KEY,
  backend TEXT NOT NULL,
  name TEXT NOT NULL,
  owner_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reauth')),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_backend_accounts_name
  ON backend_accounts(backend, COALESCE(owner_user_id, ''), name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_backend_accounts_owner ON backend_accounts(owner_user_id);
CREATE TABLE IF NOT EXISTS backend_account_grants (
  account_id TEXT NOT NULL REFERENCES backend_accounts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  granted_by TEXT,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_backend_account_grants_user ON backend_account_grants(user_id);
`);

// Who the account is signed in as, recorded by the login flow (volet 3). Added
// after volet 1 shipped, hence the guarded ALTER. NULL = never signed in
// through Timon: an account signed in by hand still launches.
const accountCols = (db.prepare(`PRAGMA table_info(backend_accounts)`).all() as { name: string }[]).map((c) => c.name);
if (!accountCols.includes('identity_key')) db.exec(`ALTER TABLE backend_accounts ADD COLUMN identity_key TEXT`);
if (!accountCols.includes('identity_label')) db.exec(`ALTER TABLE backend_accounts ADD COLUMN identity_label TEXT`);
// One subscription, one account: the index refuses the duplicate even when two
// login flows finish at the same instant, which a read-then-write cannot.
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_backend_accounts_identity
  ON backend_accounts(backend, identity_key) WHERE identity_key IS NOT NULL`);

/** `cooldown` is not stored: it is the backend cooldown of the instance id. */
export type BackendAccountStatus = 'active' | 'reauth';

export type BackendAccountRow = {
  id: string;
  backend: string;
  name: string;
  owner_user_id: string | null;
  status: BackendAccountStatus;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  /** Hash of the provider identity the account is signed in as. */
  identity_key: string | null;
  /** What that identity is called (an e-mail): shown to its manager only. */
  identity_label: string | null;
};

export class BackendAccountConflictError extends Error {}
/** The subscription is already connected under another account. */
export class BackendAccountIdentityTakenError extends Error {}

const ACCOUNTS_DIR = join(TIMON_HOME, 'backend-accounts');

/** Where a login flow lets the CLI sign in before the result is checked and
 *  moved into the account. A sibling of the account directories, so the move is
 *  a rename on the same filesystem. */
export const LOGIN_STAGING_DIR = join(ACCOUNTS_DIR, '.login');

export function accountLoginStagingDir(id: string): string {
  if (!ACCOUNT_ID_RE.test(id)) throw new Error('invalid account id');
  return join(LOGIN_STAGING_DIR, id);
}

/** Where the CLI of this account keeps its configuration and its sign-in. */
export function accountConfigDir(id: string): string {
  if (!ACCOUNT_ID_RE.test(id)) throw new Error('invalid account id');
  return join(ACCOUNTS_DIR, id);
}

/** Creates the directory owner-only if needed, and returns it. */
export function ensureAccountConfigDir(id: string): string {
  return ensurePrivateDir(accountConfigDir(id));
}

export function accountInstance(row: Pick<BackendAccountRow, 'backend' | 'id'>): string {
  return accountInstanceId(row.backend, row.id);
}

function now(): number {
  return Date.now();
}

const changeListeners = new Set<() => void>();

/**
 * Called after every write that changes what an account looks like from the
 * outside: created, renamed, signed in or out, granted, deleted. The registry
 * subscribes and turns it into `backends_changed`, so an open selector updates
 * at once instead of waiting for its own cache to age out.
 */
export function onBackendAccountsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}

function accountsChanged(): void {
  for (const listener of changeListeners) {
    try { listener(); } catch (err) { console.warn(`[accounts] change listener failed: ${(err as Error).message}`); }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/.test(err.message);
}

export function createBackendAccount(input: {
  backend: string;
  name: string;
  ownerUserId: string | null;
  createdBy?: string | null;
}): BackendAccountRow {
  const name = input.name.trim();
  if (!name) throw new Error('name is required');
  const id = randomBytes(5).toString('hex');
  const at = now();
  try {
    db.prepare(`INSERT INTO backend_accounts (id, backend, name, owner_user_id, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`).run(id, input.backend, name, input.ownerUserId, input.createdBy ?? null, at, at);
  } catch (err) {
    if (isUniqueViolation(err)) throw new BackendAccountConflictError(`an account named "${name}" already exists for ${input.backend}`);
    throw err;
  }
  ensureAccountConfigDir(id);
  accountsChanged();
  return getBackendAccount(id)!;
}

export function getBackendAccount(id: string): BackendAccountRow | undefined {
  return db.prepare(`SELECT * FROM backend_accounts WHERE id = ?`).get(id) as BackendAccountRow | undefined;
}

/** Every account, oldest first: internal callers (registry, launch). */
export function listBackendAccounts(backend?: string): BackendAccountRow[] {
  return (backend
    ? db.prepare(`SELECT * FROM backend_accounts WHERE backend = ? ORDER BY created_at, id`).all(backend)
    : db.prepare(`SELECT * FROM backend_accounts ORDER BY created_at, id`).all()) as BackendAccountRow[];
}

/**
 * The access-list filter. A superadmin (or an internal caller without viewer)
 * sees every account; anyone else sees what they own and what they were granted.
 * An instance account (no owner) is the superadmin's to manage.
 */
export function accountAccessSql(viewer: DbViewer | null | undefined, alias = 'a'): { sql: string; params: unknown[] } {
  if (!viewer || viewer.isSuperadmin) return { sql: '1=1', params: [] };
  return {
    sql: `(${alias}.owner_user_id = ? OR EXISTS (SELECT 1 FROM backend_account_grants g WHERE g.account_id = ${alias}.id AND g.user_id = ?))`,
    params: [viewer.id, viewer.id],
  };
}

export function listBackendAccountsFor(viewer: DbViewer | null | undefined): BackendAccountRow[] {
  const scope = accountAccessSql(viewer);
  return db.prepare(`SELECT a.* FROM backend_accounts a WHERE ${scope.sql} ORDER BY a.created_at, a.id`)
    .all(...scope.params) as BackendAccountRow[];
}

export function getBackendAccountFor(viewer: DbViewer | null | undefined, id: string): BackendAccountRow | undefined {
  const scope = accountAccessSql(viewer);
  return db.prepare(`SELECT a.* FROM backend_accounts a WHERE a.id = ? AND ${scope.sql}`)
    .get(id, ...scope.params) as BackendAccountRow | undefined;
}

export function renameBackendAccount(id: string, name: string): BackendAccountRow | undefined {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('name is required');
  const row = getBackendAccount(id);
  if (!row) return undefined;
  try {
    db.prepare(`UPDATE backend_accounts SET name = ?, updated_at = ? WHERE id = ?`).run(trimmed, now(), id);
  } catch (err) {
    if (isUniqueViolation(err)) throw new BackendAccountConflictError(`an account named "${trimmed}" already exists for ${row.backend}`);
    throw err;
  }
  if (trimmed !== row.name) accountsChanged();
  return getBackendAccount(id);
}

/**
 * Records who the account is signed in as. Throws
 * `BackendAccountIdentityTakenError` when another account of the backend
 * already holds that identity.
 */
export function setBackendAccountIdentity(id: string, identity: { key: string; label: string } | null): void {
  const before = getBackendAccount(id);
  try {
    db.prepare(`UPDATE backend_accounts SET identity_key = ?, identity_label = ?, updated_at = ? WHERE id = ?`)
      .run(identity?.key ?? null, identity?.label ?? null, now(), id);
  } catch (err) {
    if (isUniqueViolation(err)) throw new BackendAccountIdentityTakenError('this subscription is already connected under another account');
    throw err;
  }
  if (before && (before.identity_key !== (identity?.key ?? null) || before.identity_label !== (identity?.label ?? null))) accountsChanged();
}

/** The account of this backend signed in as this identity, if any. */
export function findBackendAccountByIdentity(backend: string, key: string): BackendAccountRow | undefined {
  return db.prepare(`SELECT * FROM backend_accounts WHERE backend = ? AND identity_key = ?`).get(backend, key) as BackendAccountRow | undefined;
}

export function setBackendAccountStatus(id: string, status: BackendAccountStatus): BackendAccountRow | undefined {
  // Only a real transition: the breaker re-asserts `reauth` on every failed
  // launch, and each `backends_changed` makes every open tab refetch.
  const changed = db.prepare(`UPDATE backend_accounts SET status = ?, updated_at = ? WHERE id = ? AND status <> ?`)
    .run(status, now(), id, status).changes > 0;
  if (changed) accountsChanged();
  return getBackendAccount(id);
}

/** Removes the row, its grants and the sign-in the CLI kept for it. */
export function deleteBackendAccount(id: string): boolean {
  const removed = db.transaction(() => {
    db.prepare(`DELETE FROM backend_account_grants WHERE account_id = ?`).run(id);
    return db.prepare(`DELETE FROM backend_accounts WHERE id = ?`).run(id).changes > 0;
  })();
  if (removed) {
    rmSync(accountConfigDir(id), { recursive: true, force: true });
    accountsChanged();
  }
  return removed;
}

export function grantBackendAccount(accountId: string, userId: string, grantedBy: string | null): void {
  const added = db.prepare(`INSERT OR IGNORE INTO backend_account_grants (account_id, user_id, granted_by, granted_at) VALUES (?, ?, ?, ?)`)
    .run(accountId, userId, grantedBy, now()).changes > 0;
  if (added) accountsChanged();
}

export function revokeBackendAccountGrant(accountId: string, userId: string): boolean {
  const removed = db.prepare(`DELETE FROM backend_account_grants WHERE account_id = ? AND user_id = ?`).run(accountId, userId).changes > 0;
  if (removed) accountsChanged();
  return removed;
}

export function listBackendAccountGrants(accountId: string): string[] {
  return (db.prepare(`SELECT user_id FROM backend_account_grants WHERE account_id = ? ORDER BY granted_at, user_id`)
    .all(accountId) as { user_id: string }[]).map((row) => row.user_id);
}

export function isBackendAccountGrantedTo(accountId: string, userId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM backend_account_grants WHERE account_id = ? AND user_id = ?`).get(accountId, userId);
}

/** Accounts a user may use for one backend: their own first, then the granted ones. */
export function accountsUsableBy(userId: string, backend: string): BackendAccountRow[] {
  return db.prepare(`SELECT a.* FROM backend_accounts a
    WHERE a.backend = ? AND (a.owner_user_id = ? OR EXISTS (SELECT 1 FROM backend_account_grants g WHERE g.account_id = a.id AND g.user_id = ?))
    ORDER BY CASE WHEN a.owner_user_id = ? THEN 0 ELSE 1 END, a.created_at, a.id`)
    .all(backend, userId, userId, userId) as BackendAccountRow[];
}

/**
 * Whether the superadmin took the accounts of this backend in hand: an account
 * they created (for anyone, or for the instance). From then on, a user without
 * an account of their own is refused instead of running on the host's
 * sign-in. A user adding their own account does not flip it for the others.
 */
export function backendAccountsManaged(backend: string): boolean {
  return !!db.prepare(`SELECT 1 FROM backend_accounts a LEFT JOIN users u ON u.id = a.created_by
    WHERE a.backend = ? AND (a.created_by IS NULL OR a.created_by = 'daemon-token' OR u.is_superadmin = 1) LIMIT 1`).get(backend);
}
