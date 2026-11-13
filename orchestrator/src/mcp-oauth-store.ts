/**
 * Where the OAuth tokens of an MCP server live: sealed in the secrets vault,
 * never in `~/.rooks/mcp/<id>.json`.
 *
 * That file sits in the user's home, readable by the shell of every agent; an
 * access or refresh token written there in clear was one `cat` away from the
 * model, relay or not. The tokens are therefore a sealed `plugin_kv` row — not
 * a `secrets` row, which the vault UI lists and a mission can be granted.
 *
 *  - The key carries the server's relay route, which derives from its id AND
 *    url (`mcp-relay-route.ts`): tokens obtained for one url are never handed to
 *    the server once it points elsewhere, and the envelope's identity is bound
 *    to that key, so it cannot be moved to another server's row either.
 *  - `@settings/` is the prefix a master-key rotation carries over (`store.ts`).
 *  - The vault off (module disabled, master key unavailable) is the degraded
 *    path of SECRETS-VAULT.md §4.4: no token can be read, none is stored, and an
 *    OAuth server answers "not connected" — never a token written in clear.
 */
import { dbApi } from './db.js';
import { isSealed } from './secrets/box.js';
import { vaultEnabled } from './secrets/availability.js';
import { openWithVault, pluginKvIdentity, sealWithVault } from './secrets/store.js';
import { mcpRelayRoute } from './mcp-relay-route.js';
import type { OAuthTokens } from './plugins/contract/mcp-servers.js';

const STORE = '@rooks/mcp-oauth';

// The relay reads tokens at every request: an unopenable row is reported once per server and process.
const openWarned = new Set<string>();

function serverPrefix(id: string): string {
  return `@settings/tokens/${id}/`;
}

function tokensKey(id: string, url: string): string {
  return `${serverPrefix(id)}${mcpRelayRoute(id, url)}`;
}

export class McpOAuthVaultUnavailableError extends Error {
  constructor() {
    super('the secrets vault is unavailable: OAuth tokens of an MCP server are stored nowhere else');
    this.name = 'McpOAuthVaultUnavailableError';
  }
}

export function mcpOAuthVaultAvailable(): boolean {
  return vaultEnabled();
}

function isTokens(value: unknown): value is OAuthTokens {
  return !!value && typeof value === 'object' && typeof (value as { access_token?: unknown }).access_token === 'string';
}

/** The tokens of a server at this url; `undefined` when none, or when the vault cannot open them. */
export function readMcpOAuthTokens(id: string, url: string): OAuthTokens | undefined {
  if (!vaultEnabled()) return undefined;
  const key = tokensKey(id, url);
  const stored = dbApi.pluginKvGet(STORE, key);
  if (!stored || !isSealed(stored)) return undefined;
  try {
    const parsed: unknown = JSON.parse(openWithVault(stored, pluginKvIdentity(STORE, key)));
    openWarned.delete(id);
    return isTokens(parsed) ? parsed : undefined;
  } catch (error) {
    // A vault error names no value.
    if (!openWarned.has(id)) {
      openWarned.add(id);
      console.warn(`[rooks] mcp ${id}: its OAuth tokens cannot be opened (${(error as Error).message})`);
    }
    return undefined;
  }
}

/**
 * Seals the tokens of a server at this url, and forgets those it held for any
 * other url. Throws `McpOAuthVaultUnavailableError` rather than keep them anywhere else.
 */
export function storeMcpOAuthTokens(id: string, url: string, tokens: OAuthTokens): void {
  if (!vaultEnabled()) throw new McpOAuthVaultUnavailableError();
  const key = tokensKey(id, url);
  let envelope: string;
  try {
    envelope = sealWithVault(JSON.stringify(tokens), pluginKvIdentity(STORE, key));
  } catch {
    throw new McpOAuthVaultUnavailableError();
  }
  dbApi.pluginKvSet(STORE, key, envelope);
  for (const row of dbApi.pluginKvList(STORE, serverPrefix(id))) {
    if (row.key !== key) dbApi.pluginKvDelete(STORE, row.key);
  }
}

/** Forgets every token of a server: deleted, moved to another url, or no longer OAuth. */
export function forgetMcpOAuthTokens(id: string): void {
  for (const row of dbApi.pluginKvList(STORE, serverPrefix(id))) dbApi.pluginKvDelete(STORE, row.key);
}

/** Tests: the raw rows, to prove they are sealed. */
export function mcpOAuthRowsForTest(id: string): { key: string; value: string }[] {
  return dbApi.pluginKvList(STORE, serverPrefix(id)).map(({ key, value }) => ({ key, value }));
}
