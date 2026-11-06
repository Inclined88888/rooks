/**
 * Session cookie helpers (Phase M.1). The raw token lives in an httpOnly
 * cookie; only its sha256 is stored, so a stolen row is not a stolen login.
 */
import { createHash, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'timon_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A session never outlives this, whatever the activity: a stolen cookie must not live forever. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Sliding expiry (TIM-0057): a user who keeps working was signed out exactly 7
 * days after login. A session is extended once less than half its lifetime is
 * left (so at most one write every few days), never past `SESSION_MAX_AGE_MS`
 * after login. Returns the new expiry, or null when nothing changes.
 */
export function renewedExpiry(session: { created_at: number; expires_at: number }, now: number): number | null {
  if (session.expires_at - now >= SESSION_TTL_MS / 2) return null;
  const next = Math.min(now + SESSION_TTL_MS, session.created_at + SESSION_MAX_AGE_MS);
  return next > session.expires_at ? next : null;
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issueSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function issueInviteToken(): string {
  return issueSessionToken();
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    try {
      return decodeURIComponent(trimmed.slice(eq + 1));
    } catch {
      return trimmed.slice(eq + 1);
    }
  }
  return undefined;
}

export function serializeSessionCookie(token: string, opts: { maxAgeSec: number; secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${opts.maxAgeSec}`,
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(opts: { secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}
