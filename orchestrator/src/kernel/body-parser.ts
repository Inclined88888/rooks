/**
 * The daemon's body parser, mounted after auth and the beta gate. Its own
 * file so tests mount exactly what the daemon mounts: a route that needs its
 * raw body (a signed webhook) only works if this bypass says so.
 */
import express, { type RequestHandler } from 'express';
import { INTEGRATION_INBOUND_PATH } from '../plugins/integration-http-path.js';
import { PLUGIN_HOOK_PATH } from '../plugins/webhook-path.js';
import { PLUGIN_UPLOAD_PATH } from '../plugins/install-path.js';
import { TRIGGER_HOOK_PATH } from '../triggers/hook-path.js';
import { routeBodyLimitFor } from '../plugins/route-body-limit.js';

export function createBodyParser(): RequestHandler {
  return (req, res, next) => {
    // All verify a signature over the exact bytes: they read the raw body
    // themselves, bounded to 256 KB.
    if (req.method === 'POST' && (INTEGRATION_INBOUND_PATH.test(req.path) || TRIGGER_HOOK_PATH.test(req.path)
      || PLUGIN_HOOK_PATH.test(req.path))) { next(); return; }
    // A plugin archive is bytes, bounded by its own route (`install-routes.ts`).
    if (req.method === 'POST' && PLUGIN_UPLOAD_PATH.test(req.path)) { next(); return; }
    // Public hook bodies must never pass through the general 25 MB parser, nor
    // the routes of a plugin that bounds its own (`plugins/route-body-limit.ts`).
    const limit = /^\/api\/workflows\/hooks\/[a-f0-9]{64}\/?$/.test(req.path) ? '256kb'
      : routeBodyLimitFor(req) ?? '25mb';
    express.json({ limit })(req, res, (err?: unknown) => {
      // Express's default handler answers this with an HTML page the chat
      // could only show as "413" (TIM-0125): say what the limit is, in JSON.
      if (isTooLarge(err)) {
        res.status(413).json({ error: `request body too large (max ${limit.toUpperCase()})`, code: 'body_too_large' });
        return;
      }
      next(err);
    });
  };
}

function isTooLarge(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { type?: unknown }).type === 'entity.too.large';
}
