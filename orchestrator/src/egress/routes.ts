/**
 * `GET /api/missions/:id/egress` — a mission's journaled connections
 * (TODO #590, T3).
 *
 * Authentication is explicit: an anonymous caller gets a 401 here even where
 * the first-run API is open, and a mission's egress proxy credential never
 * reaches this handler (the auth middleware answers 401 to it). The caller
 * needs `missions:read`, then sees the mission through the same viewer as
 * every mission read: someone else's mission and an absent one are the same
 * 404.
 */
import type express from 'express';
import { z } from 'zod';
import { rejectIfDenied, requireAuth, viewerFromRequest } from '../users/identity.js';
import { scopedDb } from '../users/scoped-db.js';
import { config } from '../config/load.js';
import { egressProxyAddress } from './service.js';
import { EGRESS_RETENTION, listMissionEgress, missionEgressHosts, missionNewEgressHosts } from './journal.js';
import { apiError } from '../api-error.js';

/** Relayed as is by the CLI and `mission_egress`, whose readers would otherwise take `connections: []` for "reached nothing". */
const EGRESS_OFF_NOTICE = 'Connection journal disabled: the egress proxy is off, so this mission\'s connections are not recorded '
  + 'and an empty list says nothing about what it reached. Anything listed dates from before it was turned off. '
  + 'To enable it, set host.isolation.egress.mode to "log" in rooks.config.json and restart Rooks.';

const ParamsSchema = z.object({ id: z.string().min(1).max(200) });

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.number().int().positive().optional(),
}).strict();

export function registerEgressRoutes(app: express.IRouter): void {
  app.get('/api/missions/:id/egress', (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'missions:read')) return;
    const params = ParamsSchema.safeParse(req.params);
    const query = QuerySchema.safeParse(req.query);
    if (!params.success || !query.success) {
      const issues = [...(params.error?.issues ?? []), ...(query.error?.issues ?? [])];
      res.status(400).json({ error: 'invalid request', issues: issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) });
      return;
    }
    const mission = scopedDb(viewerFromRequest(req)).getMission(params.data.id);
    if (!mission) {
      res.status(404).json(apiError('mission_not_found', 'mission not found'));
      return;
    }
    const page = listMissionEgress(mission.id, query.data);
    const { mode } = config().host.isolation.egress;
    res.json({
      // First key: what a reader of the raw JSON meets before the list.
      ...(mode === 'off' ? { notice: EGRESS_OFF_NOTICE } : {}),
      mission_id: mission.id,
      connections: page.connections,
      has_more: page.hasMore,
      next_before: page.hasMore ? page.connections[page.connections.length - 1]!.id : null,
      hosts: missionEgressHosts(mission.id),
      new_hosts: missionNewEgressHosts(mission.id),
      retention: {
        per_mission: EGRESS_RETENTION.perMission,
        max_age_ms: EGRESS_RETENTION.maxAgeMs,
      },
      // An empty journal means nothing on its own: the reader has to know
      // whether the proxy was there to fill it.
      proxy: {
        mode,
        listening: egressProxyAddress() !== null,
      },
    });
  });
}
