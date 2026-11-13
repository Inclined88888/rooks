/**
 * Keeps embedded-browser sign-ins across restarts (TIM-0075).
 *
 * Electron never writes session cookies (no Expires) to the profile's cookie
 * database, so every one of them is gone when the app restarts, even after a
 * clean flush. Chrome keeps them with "Continue where you left off"; the
 * embedded browser does the same by re-setting each session cookie as a
 * persistent copy with identical scope. Nothing here ever reads or logs a
 * cookie value outside of the copy handed back to Chromium.
 */
import type { Cookie, CookiesSetDetails } from 'electron';

/** Chromium's cap on any cookie lifetime: a kept session cookie lasts as long as the longest cookie a site may set. */
export const KEPT_SESSION_COOKIE_DAYS = 400;

const SAME_SITE = new Set<Cookie['sameSite']>(['unspecified', 'no_restriction', 'lax', 'strict']);
// IPv6 hosts and anything exotic are skipped: a copy whose scope cannot be rebuilt exactly must not exist.
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/** A host name a cookie scope can be rebuilt from (no IPv6, nothing exotic). */
export function isCookieHost(host: string): boolean { return HOST.test(host); }

/**
 * The persistent twin of a session cookie, or null when the cookie is already
 * persistent or its scope cannot be reproduced faithfully (a wrong copy would
 * widen the cookie to hosts or paths the site never granted).
 */
export function persistentCopyOf(cookie: Cookie, now = Date.now()): CookiesSetDetails | null {
  if (!cookie.session || !SAME_SITE.has(cookie.sameSite)) return null;
  const domain = cookie.domain ?? '';
  const host = domain.startsWith('.') ? domain.slice(1) : domain;
  if (!HOST.test(host)) return null;
  const hostOnly = cookie.hostOnly ?? !domain.startsWith('.');
  const path = cookie.path?.startsWith('/') ? cookie.path : '/';
  const secure = cookie.secure === true;
  if (cookie.name.startsWith('__Host-') && (!hostOnly || path !== '/' || !secure)) return null;
  if (cookie.name.startsWith('__Secure-') && !secure) return null;
  // SameSite=None is only valid on a secure cookie; Chromium would reject the copy anyway.
  if (cookie.sameSite === 'no_restriction' && !secure) return null;
  let url: string;
  try { url = new URL(`${secure ? 'https' : 'http'}://${host}${path}`).href; } catch { return null; }
  return {
    url, name: cookie.name, value: cookie.value, path, secure, httpOnly: cookie.httpOnly === true,
    sameSite: cookie.sameSite,
    // A host-only cookie is set without a Domain attribute, otherwise it would reach subdomains.
    ...(hostOnly ? {} : { domain: `.${host}` }),
    expirationDate: Math.floor(now / 1000) + KEPT_SESSION_COOKIE_DAYS * 86_400,
  };
}

/** One diagnostic line: name, domain and lifetime. Never the value. */
export function describeCookie(cookie: Pick<Cookie, 'name' | 'domain' | 'session' | 'expirationDate'>): string {
  const lifetime = cookie.session || cookie.expirationDate === undefined
    ? 'session'
    : new Date(cookie.expirationDate * 1000).toISOString();
  return `${cookie.name}@${cookie.domain ?? '?'} (${lifetime})`;
}

/** Profile summary for the shell log: counts always, names and expiry only on request. */
export function describeCookieJar(cookies: Cookie[], detailed: boolean): string {
  const session = cookies.filter((cookie) => cookie.session).length;
  const summary = `${cookies.length} cookie(s), ${session} session-only`;
  return detailed && cookies.length ? `${summary}: ${cookies.map(describeCookie).join(', ')}` : summary;
}
