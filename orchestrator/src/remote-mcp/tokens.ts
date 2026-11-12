/**
 * Remote MCP tokens: the credential a remote agent presents to the daemon's
 * MCP endpoint (`routes.ts`), issued by a plugin through `ctx.mcp.issueToken`.
 *
 * What makes it restricted, and where each property is enforced:
 *  - one mission and its agent: `mission_id` + `agent_name`, checked again at
 *    every use (the mission must still be running under that agent);
 *  - listed tools only: `scopes`, exact names or `<prefix>_*` families,
 *    checked per call by `scopeAllows`;
 *  - short-lived: `expires_at`, capped at `REMOTE_MCP_MAX_TTL_MS`;
 *  - dies with the mission: `finishMission` deletes the rows (`db.ts`);
 *  - never a REST credential: its own table, which the REST auth middleware
 *    never reads, so the general API answers 401 to it;
 *  - plaintext never stored nor logged: only the sha256 lives here.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { db, dbApi } from '../db.js';
import { hashSessionToken } from '../users/session.js';

export const REMOTE_MCP_MIN_TTL_MS = 60_000;
export const REMOTE_MCP_MAX_TTL_MS = 24 * 60 * 60_000;
export const REMOTE_MCP_DEFAULT_TTL_MS = 60 * 60_000;
export const REMOTE_MCP_MAX_SCOPES = 200;
/** Recognisable by secret scanners and in a leaked config, never by its value. */
export const REMOTE_MCP_TOKEN_PREFIX = 'tmcp_';

/** `kanban_add` (one tool) or `kanban_*` (a family). Nothing broader. */
const SCOPE_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:_\*)?$/;

export class RemoteMcpTokenError extends Error {
  constructor(readonly code: 'invalid_scope' | 'invalid_ttl' | 'mission_not_running' | 'no_accounts', message: string) {
    super(message);
    this.name = 'RemoteMcpTokenError';
  }
}

export type RemoteMcpGrant = {
  id: string;
  missionId: string;
  agentName: string;
  scopes: readonly string[];
  issuedBy: string;
  expiresAt: number;
};

type Row = {
  id: string;
  token_hash: string;
  mission_id: string;
  agent_name: string;
  scopes: string;
  issued_by: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
};

export function isValidScope(scope: string): boolean {
  return SCOPE_RE.test(scope);
}

/** Whether a tool name falls under one of the scopes. */
export function scopeAllows(scopes: readonly string[], tool: string): boolean {
  return scopes.some((scope) => scope.endsWith('_*')
    ? tool.startsWith(scope.slice(0, -1))
    : scope === tool);
}

function toGrant(row: Row): RemoteMcpGrant {
  return {
    id: row.id,
    missionId: row.mission_id,
    agentName: row.agent_name,
    scopes: JSON.parse(row.scopes) as string[],
    issuedBy: row.issued_by,
    expiresAt: row.expires_at,
  };
}

/**
 * Issue a token for a RUNNING mission. Scopes are checked for shape here; the
 * caller checks them against the tool catalog (`catalog.ts`), which is async.
 * The plaintext is returned once and exists nowhere else.
 */
export function issueRemoteMcpToken(input: {
  missionId: string;
  scopes: readonly string[];
  ttlMs?: number;
  issuedBy: string;
  now?: number;
}): { id: string; token: string; expiresAt: number; scopes: string[] } {
  const now = input.now ?? Date.now();
  // Before setup every request on the loopback is anonymous-tolerated, so a
  // mission credential there means nothing; a remote agent needs accounts.
  if (dbApi.countUsers() === 0) {
    throw new RemoteMcpTokenError('no_accounts', 'remote MCP tokens need at least one user account on this instance');
  }
  const scopes = [...new Set(input.scopes)];
  if (scopes.length === 0 || scopes.length > REMOTE_MCP_MAX_SCOPES) {
    throw new RemoteMcpTokenError('invalid_scope', `scopes must list between 1 and ${REMOTE_MCP_MAX_SCOPES} tools or families`);
  }
  for (const scope of scopes) {
    if (typeof scope !== 'string' || !isValidScope(scope)) {
      throw new RemoteMcpTokenError('invalid_scope', `invalid scope \`${String(scope)}\`: use a tool name or a \`<prefix>_*\` family`);
    }
  }
  const ttlMs = input.ttlMs ?? REMOTE_MCP_DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs < REMOTE_MCP_MIN_TTL_MS || ttlMs > REMOTE_MCP_MAX_TTL_MS) {
    throw new RemoteMcpTokenError('invalid_ttl', `ttl must be between ${REMOTE_MCP_MIN_TTL_MS} and ${REMOTE_MCP_MAX_TTL_MS} ms`);
  }
  const mission = dbApi.getMission(input.missionId);
  if (!mission || mission.status !== 'running') {
    throw new RemoteMcpTokenError('mission_not_running', `mission \`${input.missionId}\` is not running`);
  }
  db.prepare(`DELETE FROM mcp_tokens WHERE expires_at <= ?`).run(now);
  const id = randomUUID();
  const token = REMOTE_MCP_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const expiresAt = now + Math.floor(ttlMs);
  db.prepare(
    `INSERT INTO mcp_tokens (id, token_hash, mission_id, agent_name, scopes, issued_by, created_at, expires_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(id, hashSessionToken(token), mission.id, mission.agent_name, JSON.stringify(scopes), input.issuedBy, now, expiresAt);
  return { id, token, expiresAt, scopes };
}

/** A row still honoured at `now`: unexpired, its mission running under the same agent. */
function liveRow(row: Row | undefined, now: number): row is Row {
  if (!row || row.expires_at <= now) return false;
  const mission = dbApi.getMission(row.mission_id);
  return !!mission && mission.status === 'running' && mission.agent_name === row.agent_name;
}

/**
 * The grant behind a presented token, or `undefined`: unknown, expired,
 * revoked, or its mission no longer running under the same agent. One answer
 * for all of them, so a caller learns nothing about which.
 */
export function verifyRemoteMcpToken(raw: string, now: number = Date.now()): RemoteMcpGrant | undefined {
  if (!raw.startsWith(REMOTE_MCP_TOKEN_PREFIX)) return undefined;
  const row = db.prepare(`SELECT * FROM mcp_tokens WHERE token_hash = ?`).get(hashSessionToken(raw)) as Row | undefined;
  if (!liveRow(row, now)) return undefined;
  db.prepare(`UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?`).run(now, row.id);
  return toGrant(row);
}

/**
 * The same checks again for a grant already verified at the start of a
 * request: a batch can outlive its token (a long `mission_wait`, a tool that
 * ends the mission), so every tool call asks the table, not the request.
 */
export function revalidateRemoteMcpGrant(grant: RemoteMcpGrant, now: number = Date.now()): RemoteMcpGrant | undefined {
  const row = db.prepare(`SELECT * FROM mcp_tokens WHERE id = ?`).get(grant.id) as Row | undefined;
  if (!liveRow(row, now) || row.mission_id !== grant.missionId || row.agent_name !== grant.agentName) return undefined;
  return toGrant(row);
}

/** Grant by id, live or not, for its issuer (`ctx.mcp.revokeToken`). */
export function remoteMcpTokenIssuer(id: string): string | undefined {
  const row = db.prepare(`SELECT issued_by FROM mcp_tokens WHERE id = ?`).get(id) as { issued_by: string } | undefined;
  return row?.issued_by;
}

export function revokeRemoteMcpToken(id: string): boolean {
  return db.prepare(`DELETE FROM mcp_tokens WHERE id = ?`).run(id).changes > 0;
}

export function revokeRemoteMcpTokensForMission(missionId: string): number {
  return db.prepare(`DELETE FROM mcp_tokens WHERE mission_id = ?`).run(missionId).changes;
}
