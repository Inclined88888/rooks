/**
 * `ctx.users`, `ctx.backendAccounts`: who has an account here, and who may use
 * which subscription account. Roles and groups belong to the plugin that serves
 * the accounts (`ctx.accountProvider`, `ctx.permissionSource`), not to the core.
 *
 * Superadmin only, and only in a request: a job is a plugin acting alone and
 * no human gesture stands behind it, so it manages no one. Each method runs
 * the same `dbApi` function as the route or CLI command it fronts, and leaves
 * an audit row naming the plugin and the account it ran for.
 *
 * What is deliberately NOT here, because a plugin that could do it would hold
 * the instance:
 *  - no creating or inviting an account, no password, no reset, no invitation
 *    token — nothing here ever returns a credential;
 *  - no switching `is_superadmin`, and no change to a superadmin's status;
 *  - no account sign-in, rename or removal: the owner's gestures.
 */
import { z } from 'zod';
import { dbApi, LastSuperadminError, type UserRow } from '../db.js';
import { LicenseCapabilityError } from '../license/capabilities.js';
import {
  accountInstance, grantBackendAccount, listBackendAccountGrants, listBackendAccountsFor, revokeBackendAccountGrant,
  getBackendAccountFor,
} from '../backends/accounts.js';
import { accountState } from '../plugins-bundled/backends/account-routes.js';
import {
  auditPluginAction, parseAdminInput, PluginAdminError, type AdminCallerScope,
} from './admin-support.js';

import type { PluginAccountUser, PluginBackendAccount } from './contract/accounts.js';
export type { PluginAccountUser, PluginBackendAccount } from './contract/accounts.js';

export type ScopedAccounts = {
  users: {
    list(): PluginAccountUser[];
    get(id: string): PluginAccountUser | undefined;
    /** Disabling revokes the account's sessions and tokens. A superadmin cannot be disabled. */
    setStatus(id: string, status: 'active' | 'disabled'): PluginAccountUser;
  };
  backendAccounts: {
    list(): PluginBackendAccount[];
    /** Lets these accounts use the subscription account. The owner already can. */
    grant(accountId: string, userIds: string[]): PluginBackendAccount;
    revoke(accountId: string, userIds: string[]): PluginBackendAccount;
  };
};

const Id = z.string().min(1).max(128);
const StatusSchema = z.enum(['active', 'disabled']);
const IdList = z.array(Id).min(1).max(500);

function mapError(err: unknown): never {
  if (err instanceof PluginAdminError) throw err;
  if (err instanceof LicenseCapabilityError) throw new PluginAdminError('forbidden', err.message, err.code);
  if (err instanceof LastSuperadminError) throw new PluginAdminError('conflict', 'this is the last active superadmin');
  const message = err instanceof Error ? err.message : '';
  if (/^user not found/.test(message)) throw new PluginAdminError('not_found', message);
  console.error(`[plugins] account administration failed: ${(err as Error)?.name ?? 'error'}`);
  throw new PluginAdminError('unavailable', 'the change could not be applied');
}

const userView = (u: UserRow): PluginAccountUser => ({
  id: u.id, email: u.email, name: u.name, status: u.status as PluginAccountUser['status'],
  isSuperadmin: u.is_superadmin, createdAt: u.created_at, lastLoginAt: u.last_login_at,
});

export function accountsFor(scope: AdminCallerScope): ScopedAccounts {
  /** Runs `fn` only for a superadmin's request; every method opens with it. */
  const guarded = <T>(fn: () => T): T => {
    if (scope.job || !scope.superadmin || !scope.viewer) {
      throw new PluginAdminError('forbidden', 'managing accounts is a superadmin\'s, from a request');
    }
    try { return fn(); } catch (err) { return mapError(err); }
  };
  const userOrThrow = (raw: unknown): UserRow => {
    const user = dbApi.getUserById(parseAdminInput(Id, raw));
    if (!user) throw new PluginAdminError('not_found', 'user not found');
    return user;
  };
  const accountView = (id: string): PluginBackendAccount => {
    const row = getBackendAccountFor(scope.viewer, id);
    if (!row) throw new PluginAdminError('not_found', 'unknown account');
    return {
      id: row.id, instance: accountInstance(row), backend: row.backend, name: row.name,
      ownerUserId: row.owner_user_id, state: accountState(row), grantedTo: listBackendAccountGrants(row.id),
    };
  };
  const knownUsers = (userIds: readonly string[]): void => {
    for (const userId of userIds) if (!dbApi.getUserById(userId)) throw new PluginAdminError('not_found', `unknown user ${userId}`);
  };

  return {
    users: {
      list: () => guarded(() => dbApi.listUsers().map(userView)),
      get: (id) => guarded(() => {
        const user = dbApi.getUserById(parseAdminInput(Id, id));
        return user ? userView(user) : undefined;
      }),
      setStatus: (id, status) => guarded(() => {
        const user = userOrThrow(id);
        const wanted = parseAdminInput(StatusSchema, status);
        // Neither way: re-enabling a disabled superadmin hands the instance back to them.
        if (user.is_superadmin) throw new PluginAdminError('forbidden', 'a plugin does not change the status of a superadmin');
        if (user.status !== wanted) {
          dbApi.setUserStatus(user.id, wanted);
          if (wanted === 'disabled') dbApi.revokeUserAccess(user.id);
          auditPluginAction(scope, wanted === 'disabled' ? 'user.disable' : 'user.enable', `user:${user.id}`);
        }
        return userView(dbApi.getUserById(user.id)!);
      }),
    },

    backendAccounts: {
      list: () => guarded(() => listBackendAccountsFor(scope.viewer).map((row) => accountView(row.id))),
      grant: (accountId, userIds) => guarded(() => {
        const row = getBackendAccountFor(scope.viewer, parseAdminInput(Id, accountId));
        if (!row) throw new PluginAdminError('not_found', 'unknown account');
        const users = parseAdminInput(IdList, userIds);
        knownUsers(users);
        for (const userId of users) if (userId !== row.owner_user_id) grantBackendAccount(row.id, userId, scope.userId);
        auditPluginAction(scope, 'backend_account.grant', `${accountInstance(row)} users:${users.join(',')}`);
        return accountView(row.id);
      }),
      revoke: (accountId, userIds) => guarded(() => {
        const row = getBackendAccountFor(scope.viewer, parseAdminInput(Id, accountId));
        if (!row) throw new PluginAdminError('not_found', 'unknown account');
        const users = parseAdminInput(IdList, userIds);
        for (const userId of users) revokeBackendAccountGrant(row.id, userId);
        auditPluginAction(scope, 'backend_account.revoke', `${accountInstance(row)} users:${users.join(',')}`);
        return accountView(row.id);
      }),
    },
  };
}
