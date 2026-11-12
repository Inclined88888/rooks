/**
 * secu-9 — who and from where, for every audit row.
 *
 * Two owners (`plugins-bundled/users/routes.ts` and `privileged-overrides.ts`)
 * used to carry their own copy of `actorUserId` / `actorIp`, so a fix landed on
 * half the call sites. Both now go through here.
 *
 * Two things the copies got wrong:
 *
 *   - **Attribution.** A daemon-token call is the CLI or the dispatcher, not a
 *     person. `req.auth.user` is filled with `getActiveSuperadmin()` so the
 *     mission it spawns has an owner, but writing that account into the audit
 *     log attributes operator gestures to whoever happens to be the first
 *     superadmin. Such rows now carry `actor = 'daemon'` and no `user_id`.
 *   - **Address.** `X-Forwarded-For` is a header: anyone can send it. It is read
 *     only when the TCP peer is listed in `daemon.trustedProxies`; otherwise the
 *     socket address wins, forged header or not.
 */
import type { IncomingMessage } from 'node:http';
import type { Request } from 'express';
import { config } from '../config/load.js';
import { dbApi } from '../db.js';

/** What the caller was, when it is not a plain user session. */
export type AuditActor = 'daemon' | 'api-token' | `device:${string}` | null;

/**
 * `::ffff:127.0.0.1` and `127.0.0.1` are the same host: Node hands out the
 * IPv4-mapped form on a dual-stack socket, while an operator writes the plain
 * one in the config. Comparing them raw would make `trustedProxies` look dead.
 */
function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  return (mapped?.[1] ?? trimmed).toLowerCase();
}

/**
 * What the address is read from: an Express request, or a bare upgrade request
 * (a WebSocket never goes through Express, its audit rows must not differ).
 */
export type AuditSource = Pick<IncomingMessage, 'headers' | 'socket'>;

function peerIp(req: AuditSource): string | null {
  const raw = req.socket.remoteAddress;
  return raw ? normalizeIp(raw) : null;
}

/** Is the immediate peer allowed to speak for someone else? */
function peerIsTrustedProxy(req: AuditSource): boolean {
  const trusted = config().daemon.trustedProxies;
  if (trusted.length === 0) return false;
  const peer = peerIp(req);
  if (!peer) return false;
  return trusted.some((entry) => normalizeIp(entry) === peer);
}

/** Address to record: the first forwarded hop behind a trusted proxy, else the peer. */
export function auditIp(req: AuditSource): string | null {
  if (peerIsTrustedProxy(req)) {
    const raw = req.headers['x-forwarded-for'];
    const forwarded = Array.isArray(raw) ? raw[0] : raw;
    if (typeof forwarded === 'string' && forwarded.trim()) {
      const first = forwarded.split(',')[0]!.trim();
      if (first) return normalizeIp(first);
    }
  }
  return peerIp(req);
}

/** `null` for a daemon-token call — that identity is a fallback, not an author. */
export function auditUserId(req: Request): string | null {
  if (req.auth?.kind === 'daemon-token') return null;
  return req.auth?.user?.id ?? null;
}

export function auditActor(req: Request): AuditActor {
  if (req.auth?.kind === 'daemon-token') return 'daemon';
  if (req.auth?.kind === 'api-token') return 'api-token';
  // The owner is in `user_id`; which of their machines acted is worth keeping.
  if (req.auth?.kind === 'device' && req.auth.deviceId) return `device:${req.auth.deviceId}`;
  return null;
}

/** The one way to write an audit row from an HTTP request. */
export function auditRequest(req: Request, action: string, target: string | null): void {
  dbApi.insertAuditLog({
    userId: auditUserId(req),
    actor: auditActor(req),
    action,
    target,
    ip: auditIp(req),
  });
}

/** A mission id as the CLI sends it; anything else is not echoed into a log. */
const MISSION_CLAIM = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Who made a request, in one line for the daemon log: kind of credential, then
 * ids — never the token itself. A mission token names its mission and agent; the
 * daemon-token cannot prove who holds it, so the mission its holder claims
 * (`X-ROOKS-Mission`, sent by the CLI and MCP server inside a mission) is
 * reported as a claim.
 */
export function requestActor(req: Request): string {
  const auth = req.auth;
  const from = auditIp(req);
  const at = from ? ` from ${from}` : '';
  if (!auth) return `anonymous${at}`;
  switch (auth.kind) {
    case 'api-token': {
      if (auth.missionId) {
        const agent = dbApi.getMission(auth.missionId)?.agent_name;
        return `mission ${auth.missionId}${agent ? ` (${agent})` : ''}${at}`;
      }
      return `api-token ${auth.actorId ?? auth.user?.id ?? 'unknown'}${at}`;
    }
    case 'daemon-token': {
      const claim = req.header('X-ROOKS-Mission');
      return `daemon-token${claim && MISSION_CLAIM.test(claim) ? ` (claims mission ${claim})` : ''}${at}`;
    }
    case 'device':
      return `device ${auth.deviceId ?? 'unknown'} of user ${auth.user?.id ?? 'unknown'}${at}`;
    case 'session':
      return `user ${auth.user?.id ?? 'unknown'}${at}`;
  }
}
