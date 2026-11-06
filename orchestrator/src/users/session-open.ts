/**
 * Opening a browser session: the row and the cookie, the same way for a login,
 * a setup, an accepted invitation and an account provider (`ctx.accountProvider`).
 * Moved out of the users routes so the account provider seam opens a session
 * exactly as `/api/auth/login` does, without seeing the token.
 */
import type { Response } from 'express';
import { config } from '../config/load.js';
import { dbApi } from '../db.js';
import { SESSION_TTL_MS, hashSessionToken, issueSessionToken, serializeSessionCookie } from './session.js';

export function cookieSecure(): boolean {
  const { listen, behindTlsProxy } = config().daemon;
  return behindTlsProxy || listen.host !== '127.0.0.1';
}

export function cookieOpts(): { maxAgeSec: number; secure: boolean } {
  return { maxAgeSec: Math.floor(SESSION_TTL_MS / 1000), secure: cookieSecure() };
}

export function setSession(res: Response, userId: string, userAgent: string | undefined): void {
  const token = issueSessionToken();
  const now = Date.now();
  dbApi.createSession({
    tokenHash: hashSessionToken(token),
    userId,
    expiresAt: now + SESSION_TTL_MS,
    userAgent: userAgent ?? null,
    createdAt: now,
  });
  dbApi.touchUserLogin(userId, now);
  res.setHeader('Set-Cookie', serializeSessionCookie(token, cookieOpts()));
}
