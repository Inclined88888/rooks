/**
 * Which subscription account a mission runs on, decided by the daemon at
 * every launch (TODO #52, decisions of 10/10/2026).
 *
 * - An account instance (`claude@<id>`) is used as asked, if the mission's
 *   owner may: the account's owner, a user it is granted to, the superadmin.
 *   A mission nobody owns (cron, system, plugin job) only runs on an instance
 *   account, one with no owner.
 * - A bare backend (`claude`) is the host's own sign-in for the superadmin and
 *   for missions nobody owns, unless the superadmin set up an instance account
 *   for the latter. For anyone else it is their own account, else the oldest
 *   one granted to them, else the host's sign-in as before — until the
 *   superadmin has created an account on that backend: from then on, no
 *   account means a refusal. A user adding their own account never cuts the
 *   others off.
 * - What a mission runs on is frozen at its first turn (`launchForMission`).
 *
 * Never a fallback: an account deleted, signed out or not allowed fails the
 * launch with a reason, it is not replaced by another subscription. The only
 * move between subscriptions is decided upstream, for a series' pilot
 * (`fallbackFor`, TODO #701), and only within `ownConnections`.
 */
import { db, dbApi } from '../db.js';
import { isPluginOwner } from '../users/api-tokens.js';
import {
  accountInstance, accountsUsableBy, backendAccountsManaged, getBackendAccount, isBackendAccountGrantedTo,
  listBackendAccounts, type BackendAccountRow,
} from './accounts.js';
import { isAccountInstanceId, splitBackendInstance } from './instance-id.js';

db.exec(`
CREATE TABLE IF NOT EXISTS backend_account_missions (
  mission_id TEXT PRIMARY KEY,
  backend TEXT NOT NULL,
  account_id TEXT,
  frozen_at INTEGER NOT NULL
);
`);

export type BackendAccountErrorCode = 'missing' | 'reauth' | 'forbidden' | 'unassigned';

export class BackendAccountError extends Error {
  constructor(readonly code: BackendAccountErrorCode, message: string) {
    super(message);
    this.name = 'BackendAccountError';
  }
}

export type LaunchBackend = {
  /** What the mission runs on: the bare backend or the account instance. */
  backend: string;
  account: BackendAccountRow | null;
  /** The account belongs to someone other than the mission's owner. */
  foreign: boolean;
};

type Launcher = { kind: 'system' } | { kind: 'superadmin'; id: string } | { kind: 'user'; id: string };

function launcherOf(ownerUserId: string | null | undefined): Launcher {
  if (!ownerUserId || isPluginOwner(ownerUserId)) return { kind: 'system' };
  return dbApi.getUserById(ownerUserId)?.is_superadmin
    ? { kind: 'superadmin', id: ownerUserId }
    : { kind: 'user', id: ownerUserId };
}

const NO_FALLBACK = 'Timon never moves a mission to another subscription on its own.';

function usable(account: BackendAccountRow, launcher: Launcher): LaunchBackend {
  if (account.status === 'reauth') {
    throw new BackendAccountError('reauth',
      `The ${account.backend} account "${account.name}" must sign in again before it can run missions. ${NO_FALLBACK}`);
  }
  const owner = launcher.kind === 'system' ? null : launcher.id;
  return { backend: accountInstance(account), account, foreign: account.owner_user_id !== owner };
}

function allowed(account: BackendAccountRow, launcher: Launcher): boolean {
  if (launcher.kind === 'superadmin') return true;
  if (launcher.kind === 'system') return account.owner_user_id === null;
  return account.owner_user_id === launcher.id || isBackendAccountGrantedTo(account.id, launcher.id);
}

export function resolveLaunchBackend(name: string, ownerUserId: string | null | undefined): LaunchBackend {
  const { backend, accountId } = splitBackendInstance(name);
  const launcher = launcherOf(ownerUserId);
  if (accountId) {
    const account = getBackendAccount(accountId);
    if (!account || account.backend !== backend) {
      throw new BackendAccountError('missing',
        `The ${backend} account ${accountId} no longer exists: choose another account for this agent or task. ${NO_FALLBACK}`);
    }
    if (!allowed(account, launcher)) {
      throw new BackendAccountError('forbidden', launcher.kind === 'system'
        ? `The ${backend} account "${account.name}" belongs to a user: a mission without an owner only runs on an instance account.`
        : `The ${backend} account "${account.name}" is not assigned to the owner of this mission.`);
    }
    return usable(account, launcher);
  }
  const host: LaunchBackend = { backend, account: null, foreign: false };
  if (launcher.kind === 'superadmin') return host;
  const accounts = listBackendAccounts(backend);
  if (launcher.kind === 'system') {
    const instance = accounts.find((row) => row.owner_user_id === null);
    return instance ? usable(instance, launcher) : host;
  }
  const mine = accountsUsableBy(launcher.id, backend)[0];
  if (mine) return usable(mine, launcher);
  if (!accounts.length || !backendAccountsManaged(backend)) return host;
  throw new BackendAccountError('unassigned',
    `No ${backend} account is assigned to the owner of this mission: ask an administrator to assign one. ${NO_FALLBACK}`);
}

/**
 * Why `ownerUserId` may not name this account instance in a config (agent,
 * task, role, series rule), or null. Same rule as the launch, minus the
 * sign-in state: an account that must sign in again is still theirs to pick.
 * A bare backend id names no account and is never refused here.
 */
export function accountInstanceRefusal(name: string, ownerUserId: string | null | undefined): string | null {
  const { backend, accountId } = splitBackendInstance(name);
  if (!accountId) return null;
  const account = getBackendAccount(accountId);
  if (!account || account.backend !== backend) return `the ${backend} account ${accountId} does not exist`;
  const launcher = launcherOf(ownerUserId);
  if (allowed(account, launcher)) return null;
  return launcher.kind === 'system'
    ? `the ${backend} account "${account.name}" belongs to a user: without an owner, only an instance account can be named`
    : `the ${backend} account "${account.name}" is not assigned to you: ask an administrator to assign it, or leave the backend unset`;
}

/**
 * Every way `ownerUserId` may run on this provider by right of their own, the
 * default connection first (what a bare backend resolves to for them), then
 * their accounts, the ones granted to them, and — for the superadmin or a
 * mission nobody owns — the instance accounts. Never another user's account,
 * not even for the superadmin: being allowed to launch on it is not owning the
 * subscription. Signed-out accounts are left out.
 *
 * What the pilot's fallback may move to inside one provider (TODO #701): the
 * one exception to "never another subscription", see `fallbackFor`.
 */
export function ownConnections(name: string, ownerUserId: string | null | undefined): string[] {
  const { backend } = splitBackendInstance(name);
  const launcher = launcherOf(ownerUserId);
  const out: string[] = [];
  try { out.push(resolveLaunchBackend(backend, ownerUserId).backend); } catch { /* no default connection */ }
  const owner = launcher.kind === 'system' ? null : launcher.id;
  const accounts = launcher.kind === 'user'
    ? accountsUsableBy(launcher.id, backend)
    : listBackendAccounts(backend)
      .filter((row) => row.owner_user_id === null || row.owner_user_id === owner
        || (owner !== null && isBackendAccountGrantedTo(row.id, owner)))
      .sort((a, b) => Number(a.owner_user_id !== owner) - Number(b.owner_user_id !== owner));
  for (const row of accounts) {
    if (row.status !== 'active') continue;
    const id = accountInstance(row);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Same resolution, for a comparison only: the name it would run on, or the
 *  name itself when the launch would be refused. */
export function launchBackendName(name: string, ownerUserId: string | null | undefined): string {
  try {
    return resolveLaunchBackend(name, ownerUserId).backend;
  } catch {
    return name;
  }
}

type Frozen = { backend: string; account_id: string | null; frozen_at: number };

function frozenLaunch(missionId: string): Frozen | undefined {
  return db.prepare(`SELECT backend, account_id, frozen_at FROM backend_account_missions WHERE mission_id = ?`)
    .get(missionId) as Frozen | undefined;
}

/**
 * The launch of one turn of a mission. The first turn resolves and FREEZES
 * what the mission runs on, the host's sign-in included: a session lives in
 * its sign-in's directory, so an account created or granted later must not
 * move a running conversation. Later turns keep the frozen choice for the
 * same backend and only re-check it (account still there, still allowed, not
 * signed out). `replaceMissionLaunch` resolves an explicit switch anew.
 *
 * The first use of an account its owner does not own is audited, once per
 * mission and account.
 */
export function launchForMission(missionId: string, name: string, ownerUserId: string | null | undefined): LaunchBackend {
  const frozen = frozenLaunch(missionId);
  const { backend, accountId } = splitBackendInstance(name);
  const kept = frozen && !accountId && splitBackendInstance(frozen.backend).backend === backend ? frozen.backend : null;
  const launch: LaunchBackend = kept && !isAccountInstanceId(kept)
    ? { backend: kept, account: null, foreign: false }
    : resolveLaunchBackend(kept ?? name, ownerUserId);
  if (frozen?.backend === launch.backend) return launch;
  db.prepare(`INSERT INTO backend_account_missions (mission_id, backend, account_id, frozen_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(mission_id) DO UPDATE SET backend = excluded.backend, account_id = excluded.account_id, frozen_at = excluded.frozen_at`)
    .run(missionId, launch.backend, launch.account?.id ?? null, Date.now());
  if (launch.account && launch.foreign) {
    dbApi.insertAuditLog({
      userId: ownerUserId && !isPluginOwner(ownerUserId) ? ownerUserId : null,
      actor: isPluginOwner(ownerUserId) ? ownerUserId : null,
      action: 'backend_account.use',
      target: `${launch.backend} mission:${missionId}`,
    });
  }
  return launch;
}

/** The account a mission was frozen on, if any. */
export function missionAccountId(missionId: string): string | null {
  return frozenLaunch(missionId)?.account_id ?? null;
}

/** An explicit handover replaces the freeze, including account -> host on the
 *  same provider. Keep the old freeze so a failed launch remains resumable. */
export function replaceMissionLaunch(missionId: string, name: string, ownerUserId: string | null | undefined): () => void {
  const previous = frozenLaunch(missionId);
  const restore = (): void => {
    if (previous) {
      db.prepare(`INSERT OR REPLACE INTO backend_account_missions (mission_id, backend, account_id, frozen_at) VALUES (?, ?, ?, ?)`)
        .run(missionId, previous.backend, previous.account_id, previous.frozen_at);
    } else {
      db.prepare('DELETE FROM backend_account_missions WHERE mission_id = ?').run(missionId);
    }
  };
  db.transaction(() => {
    db.prepare('DELETE FROM backend_account_missions WHERE mission_id = ?').run(missionId);
    launchForMission(missionId, name, ownerUserId);
  })();
  return restore;
}
