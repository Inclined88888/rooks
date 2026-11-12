/**
 * Refresh a CLI OAuth token and rewrite THAT CLI's store.
 *
 * Usage probes read the token obtained by the CLI at sign-in. That token only
 * lives for a few hours and the CLI renews it only while it runs. A machine on
 * which the CLI has not run since the morning would therefore return 401 for
 * every probe.
 *
 * Refreshing without persisting is insufficient: the CLI would read the dead
 * token on its next launch and every probe would spend another OAuth roundtrip.
 *
 * Writes are atomic, mode 0600, preserve unknown fields and respect a live CLI
 * lock. Refreshes are serialized per provider because rotating refresh tokens
 * must never be exchanged concurrently.
 */
import { chmodSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A token near expiry is already unusable by the time the request leaves. */
export const EXPIRY_MARGIN_MS = 2 * 60_000;

/**
 * CLIs may leave lock files behind, so presence alone cannot prevent every
 * future store update.
 */
const LOCK_STALE_MS = 30_000;

export function isExpired(expiresAt: number | null, now = Date.now()): boolean {
  // An unknown expiry is treated as expired: an extra refresh is safer than a
  // silently dead usage gauge.
  if (expiresAt === null) return true;
  return expiresAt - EXPIRY_MARGIN_MS <= now;
}

/** Epoch milliseconds from RFC3339 or numeric expiry values. */
export function expiryMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Local HH:MM for an error a human can correlate with the CLI session. */
export function hhmm(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Whether the CLI currently holds its store lock. */
function lockHeld(lockPath: string, now: number): boolean {
  try {
    return now - statSync(lockPath).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Atomically replaces `path` with `data`. Returns false without writing while
 * the CLI lock is held; callers can still use the fresh in-memory token.
 */
export function writeStoreAtomically(path: string, data: unknown, lockPath?: string): boolean {
  const now = Date.now();
  if (lockPath && lockHeld(lockPath, now)) return false;
  const tmp = join(dirname(path), `.${now}-${process.pid}.tmp`);
  try {
    // Apply 0600 at creation so the store is never briefly world-readable.
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    return true;
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw error;
  }
}

/**
 * Serializes refreshes for one provider so a second caller waits for the token
 * rotation already in flight.
 */
export function serializeRefresh<T>(
  slot: { current: Promise<T> | null },
  run: () => Promise<T>,
): Promise<T> {
  if (slot.current) return slot.current;
  const pending = run().finally(() => { slot.current = null; });
  slot.current = pending;
  return pending;
}

export type RefreshedToken = {
  accessToken: string;
  /** Only present when the provider rotated the token. */
  refreshToken?: string;
  /** Epoch milliseconds computed from `expires_in`. */
  expiresAt: number;
  /** Epoch milliseconds when the provider reports refresh-token expiry. */
  refreshTokenExpiresAt?: number;
};

/**
 * Standard OAuth 2 refresh-token exchange using a form-encoded body.
 *
 * Error bodies are truncated but retained because `invalid_grant` tells the
 * user that signing in through the CLI again is required.
 */
export async function exchangeRefreshToken(opts: {
  tokenEndpoint: string;
  refreshToken: string;
  clientId: string;
  scope?: string;
  encoding?: 'form' | 'json';
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<RefreshedToken> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
  });
  if (opts.scope) body.set('scope', opts.scope);
  const encoding = opts.encoding ?? 'form';
  const response = await (opts.fetchImpl ?? fetch)(opts.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': encoding === 'json' ? 'application/json' : 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      ...opts.headers,
    },
    body: encoding === 'json' ? JSON.stringify(Object.fromEntries(body)) : body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`token endpoint ${response.status}: ${text.slice(0, 200)}`);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('token endpoint returned a non-JSON body');
  }
  const accessToken = payload.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('token endpoint returned no access_token');
  }
  const expiresIn = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
    ? payload.expires_in
    // Prefer an extra refresh over silently using an expired token.
    : 3600;
  const refreshedAt = (opts.now ?? Date.now)();
  return {
    accessToken,
    ...(typeof payload.refresh_token === 'string' && payload.refresh_token
      ? { refreshToken: payload.refresh_token }
      : {}),
    expiresAt: refreshedAt + expiresIn * 1000,
    ...(typeof payload.refresh_token_expires_in === 'number'
      && Number.isFinite(payload.refresh_token_expires_in)
      ? { refreshTokenExpiresAt: refreshedAt + payload.refresh_token_expires_in * 1000 }
      : {}),
  };
}
