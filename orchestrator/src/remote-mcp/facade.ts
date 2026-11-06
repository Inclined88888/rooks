/**
 * Host side of `ctx.mcp` (permission `mcp:issue`): a plugin issues and revokes
 * remote MCP tokens for the missions it may act for.
 *
 * Which missions: one its caller can see (in a request, the user's own; in a
 * job, the missions this plugin owns), or one that runs on a backend this
 * plugin brought — the case of a provider plugin whose agent lives on another
 * machine and must reach the Timon tools of the mission it drives. Anything
 * else answers like a mission that does not exist.
 */
import { dbApi, type DbViewer } from '../db.js';
import { loadConfig } from '../agent-config.js';
import { installedProfiles, registeredBackendOwners } from '../backends/registry.js';
import { scopedDb } from '../users/scoped-db.js';
import { loadMcpCatalog } from './catalog.js';
import { REMOTE_MCP_PATH } from './auth.js';
import {
  isValidScope, issueRemoteMcpToken, remoteMcpTokenIssuer, revokeRemoteMcpToken, RemoteMcpTokenError, scopeAllows,
} from './tokens.js';

export type RemoteMcpIssueInput = { missionId: string; scopes: readonly string[]; ttl?: number };

export type RemoteMcpIssued = { id: string; token: string; expiresAt: number; scopes: string[]; path: string };

function missionBackend(missionId: string): string | undefined {
  const mission = dbApi.getMission(missionId);
  if (!mission) return undefined;
  if (mission.backend_override) return mission.backend_override;
  try { return loadConfig(mission.agent_name).backend; } catch { return undefined; }
}

function backendOwnedBy(backend: string, pluginId: string): boolean {
  const owners = registeredBackendOwners();
  if (owners.profiles[backend] === pluginId) return true;
  const profile = installedProfiles().find((p) => p.id === backend);
  return profile !== undefined && owners.dialects[profile.dialect] === pluginId;
}

function mayActFor(pluginId: string, missionId: string, viewer: DbViewer | null): boolean {
  if (scopedDb(viewer).getMission(missionId)) return true;
  const backend = missionBackend(missionId);
  return backend !== undefined && backendOwnedBy(backend, pluginId);
}

export async function issueForPlugin(pluginId: string, input: RemoteMcpIssueInput, viewer: DbViewer | null): Promise<RemoteMcpIssued> {
  if (typeof input?.missionId !== 'string' || !mayActFor(pluginId, input.missionId, viewer)) {
    throw new RemoteMcpTokenError('mission_not_running', `mission \`${String(input?.missionId)}\` is not running`);
  }
  const scopes = Array.isArray(input.scopes) ? input.scopes : [];
  // A scope that names nothing is a typo the plugin would only discover when
  // the remote agent finds the tool missing.
  const { TOOLS } = await loadMcpCatalog();
  for (const scope of scopes) {
    if (typeof scope === 'string' && isValidScope(scope) && !TOOLS.some((t) => scopeAllows([scope], t.name))) {
      throw new RemoteMcpTokenError('invalid_scope', `scope \`${scope}\` matches no Timon MCP tool`);
    }
  }
  const issued = issueRemoteMcpToken({ missionId: input.missionId, scopes, ttlMs: input.ttl, issuedBy: pluginId });
  return { ...issued, path: REMOTE_MCP_PATH };
}

/** Only the plugin that issued a token may revoke it; anything else is `false`. */
export function revokeForPlugin(pluginId: string, tokenId: string): boolean {
  if (typeof tokenId !== 'string' || remoteMcpTokenIssuer(tokenId) !== pluginId) return false;
  return revokeRemoteMcpToken(tokenId);
}
