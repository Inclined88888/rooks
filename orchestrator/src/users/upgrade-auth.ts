/**
 * Identity and origin of a WebSocket upgrade, which never goes through the
 * Express auth middleware. Shared by every module that speaks WebSocket to a
 * person (today, the web terminal).
 *
 * Extracted verbatim from `plugins-bundled/terminal-web/access.ts`.
 */
import type { IncomingMessage } from 'node:http';
import { dbApi } from '../db.js';
import { freeAccountAllowed } from './free-access.js';
import type { RequestAuth } from './identity.js';
import { hashSessionToken, readCookie, SESSION_COOKIE } from './session.js';
import { isDeviceToken, lookupDevice } from './devices.js';
import { auditDeadDeviceUse, deviceTransportAllowed, noteDeviceUse } from './devices-http.js';

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const first = raw.split(',')[0]!.trim();
  return first || undefined;
}

/**
 * Cross-site WebSocket hijacking guard. A browser attaches the session cookie
 * to a WebSocket opened from ANY page, and WebSockets are not subject to
 * CORS: without this check, a page elsewhere could type into the user's
 * shell. Browsers always send `Origin` on a WebSocket, so a missing one is
 * refused too. The host compared is the one the browser reached — the app
 * proxy forwards it as `X-Forwarded-Host`, a header no page can set.
 */
export function isSameOriginUpgrade(req: IncomingMessage): boolean {
  const origin = firstHeader(req.headers.origin);
  if (!origin || origin === 'null') return false;
  const host = firstHeader(req.headers['x-forwarded-host']) ?? firstHeader(req.headers.host);
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Identity of a WebSocket upgrade, which never went through the Express auth
 * middleware. A paired device's Bearer or the session cookie, with the checks
 * the middleware applies to each (TLS for a device, live row, Free-tier).
 */
export function upgradeAuth(req: IncomingMessage): RequestAuth | undefined {
  const bearer = /^Bearer\s+(\S+)/i.exec(req.headers.authorization ?? '')?.[1];
  if (bearer && isDeviceToken(bearer)) {
    if (!deviceTransportAllowed(req)) return undefined;
    const found = lookupDevice(bearer);
    if (found.kind === 'dead') auditDeadDeviceUse(req, found.device);
    if (found.kind !== 'live' || !freeAccountAllowed(found.user.id)) return undefined;
    // Same trace as the middleware: a shell opened by a device that comes back
    // after a long silence, or from a new address, is worth an audit row.
    noteDeviceUse(req, found.device);
    return { kind: 'device', user: found.user, isSuperadmin: found.user.is_superadmin, deviceId: found.device.id };
  }
  const raw = readCookie(typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined, SESSION_COOKIE);
  if (!raw) return undefined;
  const live = dbApi.getLiveSession(hashSessionToken(raw));
  if (!live) return undefined;
  if (!freeAccountAllowed(live.user.id)) return undefined;
  dbApi.touchSession(live.session.token_hash);
  return { kind: 'session', user: live.user, isSuperadmin: live.user.is_superadmin };
}
