import { dbApi } from '../db.js';
import { userAllows } from '../users/permissions.js';
import { runPluginRequest, type PluginRequestIdentity } from './als.js';
import { PLUGIN_PERMISSIONS } from './manifest.js';
import { createIntegrationRegistries } from './integration-registry.js';

/** Daemon-owned state. This module is never exported by the public SDK. */
export const integrationRegistries = createIntegrationRegistries();

// Installed by the permission facade for one load generation (S4). A running
// transport never acquires extra rights from caller-supplied connection data.
const authorities = new Map<string, ReadonlySet<string>>();
export function grantIntegrationPermissions(pluginId: string, permissions: readonly string[]): () => void {
  if (authorities.has(pluginId)) throw new Error(`Integration authority already exists for ${pluginId}`);
  const grants = new Set(permissions);
  authorities.set(pluginId, grants);
  return () => { if (authorities.get(pluginId) === grants) authorities.delete(pluginId); };
}
export function assertIntegrationPermission(pluginId: string, permission: string): void {
  if (!authorities.get(pluginId)?.has(permission)) throw new Error(`Plugin ${pluginId} lacks ${permission}`);
}

/**
 * The owner is read from a workflow/run or an authenticated connection by the
 * host. Payload fields never enter this function as credentials. Resolve live
 * roles for every call; do not retain the ALS of the request that loaded a plugin.
 *
 * The identity is `unattended` by default: it serves callbacks nobody is in
 * front of (event handlers, webhook deliveries, workflow runs, transports), and
 * those are held to a job's spawn approval (TODO #562). A caller with a human
 * really behind the call says so with `{ attended: true }`, case by case.
 */
export function integrationRequestIdentity(
  pluginId: string, ownerUserId: string | null, opts: { attended?: true } = {},
): PluginRequestIdentity {
  const unattended = opts.attended ? {} : { unattended: true as const };
  if (ownerUserId === `plugin:${pluginId}`) {
    return {
      ownerUserId, user: undefined,
      viewer: { id: ownerUserId, isSuperadmin: false, permissions: [] },
      ...unattended,
    };
  }
  const user = ownerUserId ? dbApi.getUserById(ownerUserId) : undefined;
  if (!user || user.status !== 'active') throw new Error('Integration requires an active owner');
  const grants = dbApi.listPermissionsForUser(user.id);
  if (!userAllows(user, grants, `plugin:${pluginId}`)) throw new Error(`Owner cannot use plugin ${pluginId}`);
  // Callbacks read only their owner's data, including when the owner is admin.
  // Enumerating concrete SDK grants prevents wildcard/:all scope propagation.
  const permissions = PLUGIN_PERMISSIONS.filter((permission) => userAllows(user, grants, permission));
  return {
    ownerUserId: user.id,
    user: { id: user.id, name: user.name, email: user.email, is_superadmin: false },
    viewer: { id: user.id, isSuperadmin: false, permissions: [...permissions, `plugin:${pluginId}`] },
    ...unattended,
  };
}

export function runIntegrationCallback<T>(pluginId: string, ownerUserId: string | null, callback: () => T): T {
  return runPluginRequest(integrationRequestIdentity(pluginId, ownerUserId), callback);
}
