/**
 * `/api/integrations/receipts` — the follow-up of a messaging integration's
 * queue: what is retrying, what ran out of retries, and the gesture that sends
 * it back.
 *
 * Reading needs a real account (`req.auth.user`): the daemon token names nobody.
 * A superadmin reads every connection only from a session or device: its mission
 * tokens see its own, since a preview is a stranger's message to someone else.
 * Replaying or discarding needs a person too, as for `/api/plugin-connections`: a replay
 * starts a mission under the owner's identity, so an agent's token cannot ask for one.
 * Another account's receipt answers 404. No response carries the connection's
 * configuration, secret references, reply context or checkpoint.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { dbApi } from '../db.js';
import { auditRequest } from '../users/audit-actor.js';
import { isPersonAuth } from '../users/identity.js';
import { IntegrationQueueError, type IntegrationReceipt, type IntegrationStore } from './integration-store.js';
import { RECEIPT_LIST_LIMIT, RECEIPT_STATUSES, receiptView } from './integration-receipt-view.js';
import type { PluginMessagingConnection } from './integration-types.js';
import { apiError } from '../api-error.js';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const listQuery = z.object({
  connection: z.string().regex(ID).optional(),
  status: z.enum(RECEIPT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(RECEIPT_LIST_LIMIT.max).default(RECEIPT_LIST_LIMIT.default),
}).strict();

type Actor = { userId: string; everyAccount: boolean };

function reader(req: Request, res: Response): Actor | null {
  if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return null; }
  const user = req.auth.user;
  if (!user) { res.status(403).json({ error: 'a connection belongs to an account; sign in as a user' }); return null; }
  return { userId: user.id, everyAccount: req.auth.isSuperadmin && isPersonAuth(req.auth) };
}
function person(req: Request, res: Response): Actor | null {
  if (req.auth && !isPersonAuth(req.auth)) { res.status(403).json({ error: 'receipts are replayed by a signed-in person' }); return null; }
  return reader(req, res);
}
const sees = (actor: Actor, connection: PluginMessagingConnection): boolean =>
  actor.everyAccount || connection.identity.ownerUserId === actor.userId;

function ownerView(connection: PluginMessagingConnection, actor: Actor) {
  const id = connection.identity.ownerUserId;
  if (id === actor.userId) return null;
  const user = dbApi.getUserById(id);
  return { id, name: user?.name ?? null, email: user?.email ?? null };
}

function refused(res: Response, error: unknown): void {
  if (error instanceof IntegrationQueueError) { res.status(error.status).json({ error: error.message }); return; }
  console.error('[integrations] receipt request failed:', error instanceof Error ? error.name : 'error');
  res.status(500).json({ error: 'receipt request failed' });
}

export function registerIntegrationReceiptRoutes(router: Router, store: IntegrationStore): void {
  /** The receipt and its connection, or the 404 that also hides another account's. */
  const owned = (req: Request, res: Response, actor: Actor): { row: IntegrationReceipt; connection: PluginMessagingConnection } | null => {
    const id = String(req.params.id ?? '');
    const row = ID.test(id) ? store.getReceipt(id) : undefined;
    const connection = row && store.getConnection(row.connection_id);
    if (!row || !connection || !sees(actor, connection)) { res.status(404).json(apiError('not_found', 'not found')); return null; }
    return { row, connection };
  };
  const auditForeign = (req: Request, actor: Actor, connection: PluginMessagingConnection, action: string, target: string): void => {
    const ownerId = connection.identity.ownerUserId;
    if (ownerId !== actor.userId) auditRequest(req, action, `${target} (owner ${ownerId})`);
  };

  router.get('/api/integrations/receipts', (req, res) => {
    const actor = reader(req, res); if (!actor) return;
    const query = listQuery.safeParse(req.query);
    if (!query.success) { res.status(400).json(apiError('invalid_request', 'invalid query')); return; }
    const { connection: only, status, limit } = query.data;
    try {
      const connections = store.connectionsOf(actor.everyAccount ? null : actor.userId)
        .filter((connection) => !only || connection.id === only)
        .map((connection) => ({
          id: connection.id,
          pluginId: connection.pluginId,
          transport: connection.transport,
          agent: connection.agent,
          enabled: connection.enabled,
          owner: ownerView(connection, actor),
          counts: store.receiptCounts(connection.id),
          receipts: store.listTroubled(connection.id, status ?? null, limit).map(receiptView),
        }));
      res.json({ connections });
    } catch (error) { refused(res, error); }
  });

  router.post('/api/integrations/receipts/:id/replay', (req, res) => {
    const actor = person(req, res); if (!actor) return;
    const found = owned(req, res, actor); if (!found) return;
    try {
      if (!store.replay(found.row.id)) { res.status(409).json({ error: 'nothing to replay on this receipt' }); return; }
      auditForeign(req, actor, found.connection, 'integration_receipt.admin_replay', found.row.id);
      res.json({ ok: true });
    } catch (error) { refused(res, error); }
  });

  router.delete('/api/integrations/receipts/:id', (req, res) => {
    const actor = person(req, res); if (!actor) return;
    const found = owned(req, res, actor); if (!found) return;
    try {
      if (!store.discardFailed(found.row.id)) { res.status(409).json({ error: 'only a failed receipt can be discarded' }); return; }
      auditForeign(req, actor, found.connection, 'integration_receipt.admin_discard', found.row.id);
      res.json({ ok: true });
    } catch (error) { refused(res, error); }
  });

  router.post('/api/integrations/connections/:id/replay-failed', (req, res) => {
    const actor = person(req, res); if (!actor) return;
    const id = String(req.params.id ?? '');
    const connection = ID.test(id) ? store.getConnection(id) : undefined;
    if (!connection || !sees(actor, connection)) { res.status(404).json(apiError('not_found', 'not found')); return; }
    try {
      const replayed = store.replayFailed(connection.id);
      if (replayed) auditForeign(req, actor, connection, 'integration_receipt.admin_replay', `${connection.id}: ${replayed} receipt(s)`);
      res.json({ ok: true, replayed });
    } catch (error) { refused(res, error); }
  });
}
