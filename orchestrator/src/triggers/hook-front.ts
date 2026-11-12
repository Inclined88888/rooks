/**
 * The front of a public hook route — native triggers and plugin webhooks: a
 * path whose shape is wrong gets the caller's 401 at once, then the per-IP
 * budget, then the bounded raw body the HMAC needs. Authentication itself
 * belongs to each route, which knows its secrets.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { TRIGGER_HOOK_BODY_LIMIT } from './hook-path.js';
import type { LimitKey } from './limiter.js';

/** Per source IP, all routes together. */
const IP_RATE_LIMIT = 120;

export function flatHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(',') : value;
  }
  return out;
}

export type HookFrontOptions = {
  allow: (keys: readonly LimitKey[]) => boolean;
  /** Shape of the path parameters; a refusal answers like an unknown name. */
  accepts: (req: Request) => boolean;
  unauthorized: (res: Response) => void;
  tooMany: (res: Response) => void;
};

export function hookFront({ allow, accepts, unauthorized, tooMany }: HookFrontOptions) {
  const raw = express.raw({ type: () => true, limit: TRIGGER_HOOK_BODY_LIMIT, inflate: false });
  return (req: Request, res: Response, next: NextFunction) => {
    if (!accepts(req)) { unauthorized(res); return; }
    // Only the IP budget before authentication: a route name is readable, and
    // spending its budget on forged calls would lock its real sender out.
    if (!allow([{ key: `ip:${req.socket.remoteAddress ?? 'unknown'}`, max: IP_RATE_LIMIT }])) {
      tooMany(res);
      return;
    }
    raw(req, res, (err?: unknown) => {
      if (err) {
        const status = (err as { status?: number }).status === 413 ? 413 : 400;
        res.status(status).json({ error: status === 413 ? 'payload too large' : 'invalid body' });
        return;
      }
      next();
    });
  };
}
