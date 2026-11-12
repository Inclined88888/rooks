/**
 * Anonymous routes a plugin declares (API 15, sensitive permission `http:public`,
 * manifest `routes.publicPaths`): seam D of the multi-user extraction, for the
 * pages a person reaches before having a session (accepting an invitation).
 *
 * Only paths under the plugin's own prefix, `/api/plugins/<id>/…`, exact or with
 * named segments, never a wildcard. The core opens nothing else and puts its own
 * guards in front of what it opens: a request rate per address, a body ceiling,
 * and the cross-site refusal every cookie mutation gets. The plugin's handler
 * still decides what an anonymous caller may do; the core decides how often and
 * from where.
 */
import type { Request, Response } from 'express';
import { throttleIp } from '../users/throttle-http.js';
import { apiError } from '../api-error.js';

import { PLUGIN_PUBLIC_PATH_RE } from './manifest.js';
import type { PluginPublicPathDecl } from './contract/manifest.js';

/** Most anonymous paths a plugin may open. */
export const PUBLIC_PATHS_MAX = 10;
/** Largest body an anonymous request may carry. */
export const PUBLIC_BODY_MAX_BYTES = 64 * 1024;
/** Requests one address may make to one plugin's anonymous paths per window. */
export const PUBLIC_RATE = Object.freeze({ windowMs: 60_000, max: 60 });


type Entry = { pluginId: string; method: string; re: RegExp };

const entries = new Map<string, Entry[]>();
const hits = new Map<string, { start: number; count: number }>();

function escape(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `/invite/:token` of plugin `team` → `^/api/plugins/team/invite/[^/]+/?$`. */
export function compilePublicPath(pluginId: string, path: string): RegExp {
  if (!PLUGIN_PUBLIC_PATH_RE.test(path)) throw new Error(`invalid public path ${path}`);
  const body = path.replace(/\/$/, '').split('/').slice(1)
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : escape(seg)))
    .join('/');
  return new RegExp(`^/api/plugins/${escape(pluginId)}/${body}/?$`);
}

/** Opens a plugin's declared paths; the returned function closes them (unload). */
export function registerPluginPublicPaths(pluginId: string, decls: readonly PluginPublicPathDecl[]): () => void {
  const list = decls.slice(0, PUBLIC_PATHS_MAX).map((d) => ({ pluginId, method: d.method, re: compilePublicPath(pluginId, d.path) }));
  entries.set(pluginId, list);
  return () => {
    if (entries.get(pluginId) === list) entries.delete(pluginId);
    for (const key of [...hits.keys()]) if (key.startsWith(`${pluginId}\n`)) hits.delete(key);
  };
}

/** The plugin whose declared anonymous path this request is, `null` otherwise. */
export function matchPluginPublicPath(method: string, path: string): string | null {
  for (const list of entries.values()) {
    for (const e of list) if (e.method === method && e.re.test(path)) return e.pluginId;
  }
  return null;
}

/**
 * The core's guards in front of an anonymous plugin path. Answers the request
 * itself and returns `false` when it refuses it.
 */
export function guardPluginPublicRequest(
  req: Request,
  res: Response,
  pluginId: string,
  opts: { crossSite: boolean; now?: number },
): boolean {
  const now = opts.now ?? Date.now();
  // Computed by the auth layer, which owns the cross-site rule (`isCrossSiteMutation`).
  if (opts.crossSite) {
    res.status(403).json({ error: 'cross-site request refused' });
    return false;
  }
  const length = Number(req.header('content-length') ?? 0);
  if (Number.isFinite(length) && length > PUBLIC_BODY_MAX_BYTES) {
    res.status(413).json(apiError('payload_too_large', 'request body too large'));
    return false;
  }
  const key = `${pluginId}\n${throttleIp(req) ?? 'unknown'}`;
  const bucket = hits.get(key);
  if (!bucket || now - bucket.start >= PUBLIC_RATE.windowMs) {
    hits.set(key, { start: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  if (bucket.count > PUBLIC_RATE.max) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.start + PUBLIC_RATE.windowMs - now) / 1000))));
    res.status(429).json(apiError('too_many_attempts', 'too many requests, try again later'));
    return false;
  }
  return true;
}
