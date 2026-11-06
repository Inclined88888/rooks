/**
 * Routes of `@timon/updates`. Each declares who may call it:
 *
 *  - `GET /api/updates` — any signed-in caller: the banner, the lock screen of
 *    an ended beta build and `timon update status`. The offer is public and
 *    signed, and on a locked build it is a member's only way out, so no right
 *    beyond being signed in is asked. Never anonymous, even during first run;
 *  - `POST /api/updates/check` — a caller holding `settings:write`: it makes the
 *    daemon reach timon-ai.com now. Never anonymous. Its body is empty;
 *  - `GET /api/updates/missions` — a caller holding `settings` (read): how many
 *    missions an update would stop (docs/AUTO-UPDATE.md §6, P3). The desktop
 *    shell asks before it launches an installer and on its approval screen.
 *    Counts only, never an id, an agent or a title. Takes no query.
 *
 * The daemon token (CLI) passes both as the operator it is. A browser never
 * holds it: the web app's proxy forwards the session cookie alone.
 */
import type { Router } from 'express';
import { z } from 'zod';
import { apiError } from '../../api-error.js';
import { rejectIfDenied, requireAuth } from '../../users/identity.js';
import type { UpdateStatus } from './checker.js';

const CheckBody = z.object({}).strict();
const NoQuery = z.object({}).strict();

/** `working`: missions inside a turn, the work an update cuts short; `live`: every live mission process. */
export type MissionCount = { live: number; working: number };

export type UpdatesApi = {
  status(): UpdateStatus;
  check(): Promise<UpdateStatus>;
  missions(): MissionCount;
};

export function registerRoutes(app: Router, api: UpdatesApi): void {
  app.get('/api/updates', (req, res) => {
    if (!requireAuth(req, res)) return;
    res.json(api.status());
  });

  app.post('/api/updates/check', (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'settings:write')) return;
    const body = CheckBody.safeParse(req.body ?? {});
    if (!body.success) { res.status(400).json(apiError('invalid_request', 'this route takes no body')); return; }
    // `check()` never throws: a failed check is a status, not an error.
    void api.check().then((status) => { res.json(status); });
  });

  app.get('/api/updates/missions', (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'settings')) return;
    if (!NoQuery.safeParse(req.query).success) { res.status(400).json(apiError('invalid_request', 'this route takes no query')); return; }
    res.json(api.missions());
  });
}
