import express, { type Router } from 'express';
import { IntegrationQueueError } from './integration-store.js';
import { PluginIntegrationError } from './integration-primitives.js';
import type { IntegrationService } from './integration-service.js';
import { INTEGRATION_INBOUND_PATH } from './integration-http-path.js';
import { apiError } from '../api-error.js';

export function registerIntegrationWebhook(router: Router, service: IntegrationService): void {
  const attempts = new Map<string, { at: number; count: number }>();
  router.post('/api/integrations/:id/inbound', (req, res, next) => {
    if (!INTEGRATION_INBOUND_PATH.test(req.path)) { res.status(404).json(apiError('not_found', 'not found')); return; }
    const now = Date.now();
    for (const [key, entry] of attempts) if (now - entry.at >= 60_000) attempts.delete(key);
    const keys = [`ip:${req.ip}`, `connection:${req.params.id}`];
    if (keys.some((key) => (attempts.get(key)?.count ?? 0) >= 60) || attempts.size + 2 > 10_000) {
      res.setHeader('Retry-After', '60'); res.status(429).json(apiError('rate_limited', 'rate limited')); return;
    }
    for (const key of keys) { const old = attempts.get(key); attempts.set(key, { at: old?.at ?? now, count: (old?.count ?? 0) + 1 }); }
    next();
  }, express.raw({ type: () => true, limit: '256kb', inflate: false }), async (req, res) => {
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(new Error('Inbound request disconnected')); };
    res.on('close', abort);
    try {
      const receipt = await service.receive(req.params.id, {
        body: Buffer.isBuffer(req.body) ? req.body : new Uint8Array(),
        headers: Object.fromEntries(Object.entries(req.headers).filter((entry) => entry[1] !== undefined).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value!])),
      }, controller.signal);
      res.status(202).json(receipt ? { ok: true, receipt_id: receipt.id } : { ok: true, ignored: true });
    } catch (error) {
      const status = error instanceof IntegrationQueueError ? error.status
        : error instanceof PluginIntegrationError && error.code === 'invalid' ? 400 : 503;
      if (status === 429) res.setHeader('Retry-After', '60');
      res.status(status).json({ error: status === 401 ? 'authentication failed' : status === 404 ? 'not found' : 'integration request refused' });
    } finally { res.off('close', abort); }
  });
}
