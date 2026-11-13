/**
 * `/api/plugin-connections` — what a signed-in account does with its own
 * plugin connections, and what an administrator approves.
 *
 * Authentication is explicit on every route: an owner route needs a real
 * account (`req.auth.user`); the daemon token alone names nobody, so it can
 * neither own nor read a connection. Approval routes need a superadmin. No
 * route ever returns a secret value, and no error echoes one.
 *
 * Every change — create, edit, delete, approve, refuse — needs a SESSION: a
 * person in the app. A mission token carries its launcher's identity and the
 * daemon token resolves to the superadmin; either would let an agent open a
 * network destination to a plugin without anyone seeing it.
 */
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { dbApi } from '../db.js';
import { auditRequest } from '../users/audit-actor.js';
import { forbidden, isPersonAuth } from '../users/identity.js';
import { UserConnectionError, publicUserConnection, type ConnectionActor, type StoredUserConnection, type UserConnectionService } from './user-connections.js';
import { apiError } from '../api-error.js';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const secretName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const label = z.string().trim().min(1).max(80);
const url = z.string().trim().min(1).max(2048);
const config = z.record(z.string().max(64), z.unknown());
const createSchema = z.object({
  type: z.string().min(1).max(200),
  label,
  url,
  allowPrivateNetwork: z.boolean().optional(),
  config: config.optional(),
  secrets: z.record(secretName, z.string().min(1).max(8192)).optional(),
}).strict();
const patchSchema = z.object({
  label: label.optional(),
  url: url.optional(),
  allowPrivateNetwork: z.boolean().optional(),
  config: config.optional(),
  secrets: z.record(secretName, z.string().min(1).max(8192).nullable()).optional(),
  enabled: z.boolean().optional(),
}).strict();

/** An account, or a 401/403 already sent. */
function owner(req: Request, res: Response): ConnectionActor | null {
  if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return null; }
  const user = req.auth.user;
  if (!user) { res.status(403).json({ error: 'a connection belongs to an account; sign in as a user' }); return null; }
  return { userId: user.id, isAdmin: req.auth.isSuperadmin };
}
/** `owner` for a change: only a signed-in person, never an agent's token. */
function person(req: Request, res: Response): ConnectionActor | null {
  if (req.auth && !isPersonAuth(req.auth)) { res.status(403).json({ error: 'connections are changed by a signed-in person' }); return null; }
  return owner(req, res);
}
function admin(req: Request, res: Response): ConnectionActor | null {
  if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return null; }
  if (!req.auth.isSuperadmin) { forbidden(req, res, { kind: 'operator' }); return null; }
  return { userId: req.auth.user?.id ?? 'daemon-token', isAdmin: true };
}
function connectionId(req: Request, res: Response): string | null {
  const id = String(req.params.id ?? '');
  if (!ID.test(id)) { res.status(404).json(apiError('not_found', 'not found')); return null; }
  return id;
}

/** What a browser sees of its connection: secret names, never values. */
function view(connection: StoredUserConnection) {
  return { ...publicUserConnection(connection), approvedAt: connection.approvedAt, createdAt: connection.createdAt, updatedAt: connection.updatedAt };
}
function adminView(connection: StoredUserConnection) {
  const user = dbApi.getUserById(connection.identity.ownerUserId);
  return { ...view(connection), owner: user ? { id: user.id, name: user.name, email: user.email } : { id: connection.identity.ownerUserId, name: null, email: null } };
}

async function handle(res: Response, work: () => unknown): Promise<void> {
  try {
    res.json(await work());
  } catch (error) {
    if (error instanceof UserConnectionError) { res.status(error.status).json({ error: error.message }); return; }
    // The message of an unexpected error may come from plugin code: not echoed.
    console.error('[plugin-connections] request failed:', error instanceof Error ? error.name : 'error');
    res.status(500).json({ error: 'connection request failed' });
  }
}

export function registerUserConnectionRoutes(router: Router, service: UserConnectionService): void {
  const json = express.json({ limit: '64kb' });
  const parse = <T>(schema: z.ZodType<T>, req: Request, res: Response): T | null => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'invalid connection payload' }); return null; }
    return parsed.data;
  };

  router.get('/api/plugin-connections/types', (req, res) => {
    const actor = owner(req, res); if (!actor) return;
    void handle(res, () => ({ types: service.types(actor) }));
  });
  router.get('/api/plugin-connections', (req, res) => {
    const actor = owner(req, res); if (!actor) return;
    void handle(res, () => ({ connections: service.listOwn(actor).map(view), approvalPolicy: service.host.approvalPolicy() }));
  });
  router.post('/api/plugin-connections', json, (req, res) => {
    const actor = person(req, res); if (!actor) return;
    const body = parse(createSchema, req, res); if (!body) return;
    void handle(res, async () => ({ connection: view(await service.create(actor, body)) }));
  });
  router.patch('/api/plugin-connections/:id', json, (req, res) => {
    const actor = person(req, res); if (!actor) return;
    const id = connectionId(req, res); if (!id) return;
    const body = parse(patchSchema, req, res); if (!body) return;
    // An administrator may edit someone else's gateway: every such change is on record.
    const ownerId = service.ownerOf(id);
    if (actor.isAdmin && ownerId && ownerId !== actor.userId) auditRequest(req, 'plugin_connection.admin_update', `${id} (owner ${ownerId})`);
    void handle(res, async () => ({ connection: view(await service.update(actor, id, body)) }));
  });
  router.delete('/api/plugin-connections/:id', (req, res) => {
    const actor = person(req, res); if (!actor) return;
    const id = connectionId(req, res); if (!id) return;
    const ownerId = service.ownerOf(id);
    if (actor.isAdmin && ownerId && ownerId !== actor.userId) auditRequest(req, 'plugin_connection.admin_remove', `${id} (owner ${ownerId})`);
    void handle(res, () => { service.remove(actor, id); return { ok: true }; });
  });
  router.post('/api/plugin-connections/:id/test', (req, res) => {
    const actor = owner(req, res); if (!actor) return;
    const id = connectionId(req, res); if (!id) return;
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(new Error('client disconnected')); };
    res.on('close', abort);
    void handle(res, () => service.test(actor, id, controller.signal)).finally(() => res.off('close', abort));
  });

  // Approval: an administrator, or the owner when the operator delegated it.
  router.get('/api/plugin-connections/approvals', (req, res) => {
    const actor = admin(req, res); if (!actor) return;
    void handle(res, () => ({ connections: service.listAll().map(adminView), approvalPolicy: service.host.approvalPolicy() }));
  });
  for (const [action, approval] of [['approve', 'approved'], ['reject', 'rejected']] as const) {
    router.post(`/api/plugin-connections/:id/${action}`, (req, res) => {
      const actor = person(req, res);
      if (!actor) return;
      const id = connectionId(req, res); if (!id) return;
      void handle(res, () => ({ connection: view(service.decide(actor, id, approval)) }));
    });
  }
}
