/** Real bindings of `user-connections.ts`: config, vault envelope, `plugin_kv`. */
import { existsSync } from 'node:fs';
import { config } from '../config/load.js';
import { dbApi } from '../db.js';
import { INTEGRATIONS_DB_PATH } from '../paths.js';
import { openWithVault, PLUGIN_CONNECTION_KV_PREFIX, pluginKvIdentity, sealWithVault } from '../secrets/store.js';
import { IntegrationStore } from './integration-store.js';
import { assertFetchAllowed } from './policy.js';
import { UserConnectionStore, type UserConnectionHost } from './user-connections.js';

export function daemonUserConnectionHost(): UserConnectionHost {
  return {
    approvalPolicy: () => config().pluginPolicy.http.connectionApproval,
    writeSecret: (pluginId, key, value) => dbApi.pluginKvSet(pluginId, key, sealWithVault(value, pluginKvIdentity(pluginId, key))),
    readSecret(pluginId, key) {
      const raw = dbApi.pluginKvGet(pluginId, key);
      return raw === undefined ? undefined : openWithVault(raw, pluginKvIdentity(pluginId, key));
    },
    deleteSecret: (pluginId, key) => dbApi.pluginKvDelete(pluginId, key),
    allowlisted(pluginId, url) {
      try { assertFetchAllowed(pluginId, url); return true; } catch { return false; }
    },
  };
}

/**
 * A plugin's uninstallation (TODO #664). Rows are indexed by the id, not the
 * package: a package republished under it, another author's included, would reach
 * every origin approved for the old one, private network included, and read the
 * keys users deposited for it. So approvals go back to pending and the keys are
 * deleted; the connection survives for its owner to fill in again.
 *
 * Runs in the CLI as well as the daemon, hence its own short-lived handle, and
 * needs no vault key. No file means no connection was ever created: never made
 * here. Rows first: interrupted in between, an unlisted key is unreachable, while
 * an approved row would keep the origin open. The keys go by prefix, not by the
 * names on the rows, and even when the rows cannot be reached.
 *
 * Returns the ids of the connections it changed.
 */
export function withdrawPluginUserConnections(pluginId: string, file: string = INTEGRATIONS_DB_PATH): string[] {
  try {
    if (!existsSync(file)) return [];
    const store = new IntegrationStore(file);
    try {
      return new UserConnectionStore(store.db).withdrawPlugin(pluginId).map((connection) => connection.id);
    } finally {
      store.close();
    }
  } finally {
    for (const { key } of dbApi.pluginKvList(pluginId, PLUGIN_CONNECTION_KV_PREFIX)) dbApi.pluginKvDelete(pluginId, key);
  }
}
