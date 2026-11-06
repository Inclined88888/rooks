/**
 * The daemon's relay for an MCP server connected by OAuth: what the agent's CLI
 * is handed instead of the server's url and bearer.
 *
 * Writing `Authorization: Bearer <access_token>` into the MCP configuration of a
 * CLI (`--mcp-config`, a `config.toml`) put the token in a file of the mission's
 * scratch folder, readable by the shell the model drives. So, like the vault's
 * broker (`timon_http_call`), the daemon holds the credential and the agent only
 * asks: its CLI talks to `http://127.0.0.1:<daemon port>/mcp-relay/<route>/<agent>`
 * with a relay token, and the relay (`mcp-relay-server.ts`) adds the current
 * OAuth bearer on its way out.
 *
 *  - `<route>` derives from the server's id AND url: a url changed after the
 *    launch is another route, and the old one leads nowhere.
 *  - The relay token is an HMAC, keyed by a secret of the daemon kept sealed in
 *    the vault, over the route, the agent and the mission: it opens one route,
 *    for one agent, and names the mission it was minted for. Being derived, it
 *    survives a daemon restart (a resumed codex session keeps working) without
 *    any table of issued tokens.
 *  - No vault, no relay: a key held in memory only would die with the daemon
 *    and silently break every resumed session, so an OAuth server is then left
 *    out of the launch and the relay refuses everything (the OAuth tokens are
 *    in the vault anyway, `mcp-oauth-store.ts`).
 *
 * The token sits in the CLI's configuration like any other header, so it is
 * worth nothing off this machine's loopback, nor for another agent or route.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { apiPort } from './api-url.js';
import { dbApi } from './db.js';
import { MCP_RELAY_HEADER, MCP_RELAY_PREFIX, mcpRelayRoute } from './mcp-relay-route.js';
import { isSealed } from './secrets/box.js';
import { vaultEnabled } from './secrets/availability.js';
import { openWithVault, pluginKvIdentity, sealWithVault } from './secrets/store.js';

export { MCP_RELAY_HEADER, MCP_RELAY_PREFIX, isMcpRelayRoute, mcpRelayRoute } from './mcp-relay-route.js';

/** `@settings/` puts the sealed row in what a vault key rotation carries over (`store.ts`). */
const KEY_STORE = '@timon/mcp-relay';
const KEY_NAME = '@settings/relay-key';

const AGENT_RE = /^[A-Za-z0-9._-]+$/;
const MISSION_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isMcpRelayAgent(value: string): boolean {
  return AGENT_RE.test(value);
}

let cachedKey: Buffer | null = null;
let unavailableWarned = false;

function unavailable(reason: string): null {
  if (!unavailableWarned) {
    unavailableWarned = true;
    console.warn(`[timon] mcp relay unavailable: ${reason}; OAuth MCP servers are left out of launches until it is back`);
  }
  return null;
}

/**
 * The relay's HMAC key: 32 random bytes sealed in the vault, minted at first
 * use; `null` while the vault is off or cannot hold it. Only a key is cached,
 * never its absence: the vault back, the next call finds it.
 */
export function mcpRelayKey(): Buffer | null {
  if (cachedKey) return cachedKey;
  if (!vaultEnabled()) return unavailable('the secrets vault is off');
  const identity = pluginKvIdentity(KEY_STORE, KEY_NAME);
  try {
    const stored = dbApi.pluginKvGet(KEY_STORE, KEY_NAME);
    if (stored && isSealed(stored)) {
      const key = Buffer.from(openWithVault(stored, identity), 'base64url');
      if (key.length === 32) {
        cachedKey = key;
        unavailableWarned = false;
        return key;
      }
      // A key that opens wrong is not replaced: a fresh one would void every token already handed out.
      return unavailable('the relay key in the vault is unreadable');
    }
    const fresh = randomBytes(32);
    dbApi.pluginKvSet(KEY_STORE, KEY_NAME, sealWithVault(fresh.toString('base64url'), identity));
    cachedKey = fresh;
    unavailableWarned = false;
    return fresh;
  } catch (error) {
    // The message of a vault error names no value; the key is never printed.
    return unavailable(`the secrets vault cannot hold the relay key (${(error as Error).message})`);
  }
}

function mac(key: Buffer, route: string, agent: string, missionId: string): string {
  return createHmac('sha256', key).update(`timon-mcp-relay/v1\n${route}\n${agent}\n${missionId}`).digest('base64url');
}

/** `<missionId>.<hmac>`: the mission is readable, the binding is not forgeable. */
export function mintMcpRelayToken(key: Buffer, route: string, agent: string, missionId: string): string {
  if (!MISSION_RE.test(missionId)) throw new Error('invalid mission id for an mcp relay token');
  return `${missionId}.${mac(key, route, agent, missionId)}`;
}

/** The mission a token was minted for, when it was minted for this route and agent; `null` otherwise. */
export function verifyMcpRelayToken(key: Buffer, token: string, route: string, agent: string): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const missionId = token.slice(0, dot);
  if (!MISSION_RE.test(missionId)) return null;
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(key, route, agent, missionId));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return missionId;
}

export type McpRelayCaller = { agent: string; missionId: string };

/**
 * What a CLI is handed for an OAuth server: the relay's url and the header that
 * opens it; `null` when the relay has no key (vault off): the server is then left out.
 */
export function mcpRelayLaunchTarget(
  server: { id: string; url: string },
  caller: McpRelayCaller,
  options: { key?: Buffer; port?: number } = {},
): { url: string; headers: Record<string, string> } | null {
  if (!AGENT_RE.test(caller.agent)) throw new Error('invalid agent name for an mcp relay');
  const key = options.key ?? mcpRelayKey();
  if (!key) return null;
  const route = mcpRelayRoute(server.id, server.url);
  const token = mintMcpRelayToken(key, route, caller.agent, caller.missionId);
  // 127.0.0.1, not `apiBaseUrl()`: the daemon always binds it (`listen-hosts.ts`), and
  // `TIMON_ORCH_URL` may name a proxy the relay refuses.
  const port = options.port ?? apiPort();
  return {
    url: `http://127.0.0.1:${port}${MCP_RELAY_PREFIX}${route}/${encodeURIComponent(caller.agent)}`,
    headers: { [MCP_RELAY_HEADER]: token },
  };
}

/** Tests: forget the key held in memory. */
export function resetMcpRelayKeyForTest(): void {
  cachedKey = null;
  unavailableWarned = false;
}
