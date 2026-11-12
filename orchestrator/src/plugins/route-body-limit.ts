/**
 * Body limits owned by a plugin's routes (`/api/plugins/<id>/…`), read by the
 * daemon's body parser (`kernel/body-parser.ts`) BEFORE it reads a byte: a
 * route cannot bound a JSON body once the general parser has already held
 * 25 MB of it in memory (TODO #585).
 *
 * Its own file, with no import, so the kernel's parser does not pull the
 * plugin context's import graph.
 */
import type { Request } from 'express';

/** The limit for this request, or `undefined` to fall back to the general one. */
export type RouteBodyLimit = (req: Request) => string | undefined;

/**
 * A plugin with a `runtime: daemon` dictation engine receives audio blocks as
 * base64 JSON through `ctx.api`. 1 MB is ~23 s of 16 kHz 16-bit PCM per
 * request: a block, never a whole dictation.
 */
export const DICTATION_DAEMON_BODY_LIMIT = '1mb';

/** Case-insensitive, like Express's routing: `/api/plugins/ACME/…` reaches
 *  the router mounted at `/api/plugins/acme`, so it must meet its limit too. */
const PLUGIN_ROUTE_RE = /^\/api\/plugins\/([^/]+)(?:\/|$)/i;

/** id → one entry per live `ctx.router()` (a plugin may call it twice). */
const limits = new Map<string, RouteBodyLimit[]>();

/** Registers `limit` for the routes of `id`; the returned function removes it. */
export function registerRouteBodyLimit(id: string, limit: RouteBodyLimit): () => void {
  const list = limits.get(id) ?? [];
  list.push(limit);
  limits.set(id, list);
  return () => {
    const current = limits.get(id);
    if (!current) return;
    const index = current.indexOf(limit);
    if (index >= 0) current.splice(index, 1);
    if (current.length === 0) limits.delete(id);
  };
}

export function routeBodyLimitFor(req: Request): string | undefined {
  const match = PLUGIN_ROUTE_RE.exec(req.path);
  if (!match) return undefined;
  // Ids are lowercase slugs (`manifest.ts`); Express matches the mount path
  // undecoded, so a percent-encoded id reaches no plugin router at all.
  const list = limits.get((match[1] ?? '').toLowerCase());
  return list && list.length > 0 ? list[list.length - 1]?.(req) : undefined;
}
