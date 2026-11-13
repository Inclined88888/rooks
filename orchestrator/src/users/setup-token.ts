/**
 * One-time setup token (TODO #327). The daemon cannot tell a visitor of an
 * exposed WebUI from the operator at the keyboard: the UI proxy, Tailscale
 * Serve, a reverse proxy and a tunnel all reach it from the loopback. So when
 * a listener is exposed, the first superadmin is created only by someone who
 * can read the home — the proof of presence is this file, printed by
 * `rooks setup-token`, never logged and never sent in a query string.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOKS_HOME } from '../paths.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/** True when anything but this machine may reach the daemon, directly or through the WebUI. */
export function setupListenerExposed(cfg: {
  daemon: { listen: { host: string }; behindTlsProxy: boolean };
  app: { listen: { host: string } };
}): boolean {
  return !isLoopbackHost(cfg.daemon.listen.host)
    || !isLoopbackHost(cfg.app.listen.host)
    // HTTPS terminated by a reverse proxy: the operator declared a public front.
    || cfg.daemon.behindTlsProxy;
}

function tokenPath(): string {
  return join(ROOKS_HOME, 'setup-token');
}

/** The current token, created on first use. Owner-only where the OS honours it. */
export function readOrCreateSetupToken(): string {
  const path = tokenPath();
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) return existing;
  }
  const token = randomBytes(32).toString('base64url');
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort: Windows has no POSIX modes */ }
  return token;
}

/** Constant-time comparison; false when no token was ever issued. */
export function verifySetupToken(candidate: unknown): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 256) return false;
  const path = tokenPath();
  if (!existsSync(path)) return false;
  const expected = Buffer.from(readFileSync(path, 'utf8').trim());
  const given = Buffer.from(candidate.trim());
  return expected.length > 0 && expected.length === given.length && timingSafeEqual(expected, given);
}

/** Single use: dropped once the first account exists. */
export function consumeSetupToken(): void {
  try { unlinkSync(tokenPath()); } catch { /* already gone */ }
}
