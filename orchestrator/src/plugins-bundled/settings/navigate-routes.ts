/**
 * Navigation, as an agent reaches it: list the pages (`ui_routes`) and ask the
 * owner to go to one (`ui_navigate`).
 *
 * The screen is never changed from here: a navigation is a proposal the owner
 * follows from a card in the mission's conversation (`layout-proposals.ts`,
 * kind `navigate`), the same card and the same decision as a layout.
 */
import type { Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { bus } from '../../bus.js';
import { dbApi, type MissionRow } from '../../db.js';
import { scopedDb } from '../../users/scoped-db.js';
import { auditRequest } from '../../users/audit-actor.js';
import { forbidden, viewerFromRequest, isPersonAuth } from '../../users/identity.js';
import { galleryPlugins, loaderFromApp } from '../../plugins/runtime.js';
import type { PluginPublic } from '../../plugins/public.js';
import {
  createLayoutProposal,
  layoutProposalView,
  PROPOSAL_PENDING_REPLY,
  registerProposalKind,
  type AuditFn,
  type ProposalOrigin,
  type Reply,
} from './layout-proposals.js';
import { pageOpenerFor } from '../../users/surfaces.js';
import {
  describeRoutes,
  NAVIGATE_PROPOSAL_MAX_BYTES,
  NavigateProposal,
  pluginPages,
  validateNavigateProposal,
  type CorePageAllowed,
  type PluginPage,
} from './navigate-model.js';
import { allowedFor, callerOf, ownerViewer, type Caller } from './widget-routes.js';
import { apiError } from '../../api-error.js';

export const NAVIGATE_KIND = 'navigate';

/**
 * Where a direct-navigation grant lives: one row per account. Only a browser
 * session creates it (below), and a mission token cannot write `/api/layout`
 * (`refuseMissionWrite`), so an agent has no way to give itself one.
 */
export const NAVIGATE_GRANT_SCOPE = 'navigate.grant';
export const NAVIGATE_GRANT_MAX_MINUTES = 60;

type StoredGrant = { missionId: string; until: number };

function readGrant(raw: string | undefined): StoredGrant | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredGrant>;
    return typeof v.missionId === 'string' && typeof v.until === 'number' ? { missionId: v.missionId, until: v.until } : null;
  } catch { return null; }
}

/** The grant of this account, when it names this mission and has not run out. */
export function liveGrant(ownerId: string, missionId: string, now = Date.now()): StoredGrant | null {
  const g = readGrant(dbApi.uiLayoutGetOwn(ownerId, NAVIGATE_GRANT_SCOPE)?.value);
  return g && g.missionId === missionId && g.until > now ? g : null;
}

const GrantBody = z.object({
  missionId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  minutes: z.number().int().min(1).max(NAVIGATE_GRANT_MAX_MINUTES).optional(),
}).strict();

/** The plugin pages this owner may be sent to: active plugins their grants open, never the token's cap. */
export function ownerPluginPages(caller: Caller, plugins: readonly PluginPublic[]): PluginPage[] {
  return pluginPages(plugins, allowedFor(caller.owner, plugins));
}

/** The product's pages this owner's page gate opens: their grants, never the token's cap. */
export function ownerCorePages(caller: Caller, plugins: readonly PluginPublic[]): CorePageAllowed {
  return pageOpenerFor(ownerViewer(caller.owner), plugins);
}

/**
 * `POST /api/navigate/proposals`: validates the destination and raises its card
 * in the caller's mission. `direct` lets a live guided tour of THIS mission skip
 * the card: only the agent's own route passes it.
 */
export function proposeNavigate(
  caller: Caller & { mission: MissionRow },
  raw: Record<string, unknown>,
  plugins: readonly PluginPublic[],
  audit: AuditFn,
  direct: boolean,
  origin?: ProposalOrigin,
): Reply {
  if (Buffer.byteLength(JSON.stringify(raw)) > NAVIGATE_PROPOSAL_MAX_BYTES) return { status: 413, body: { error: 'too_large' } };
  const { note: rawNote, ...rest } = raw;
  const note = z.string().max(300).optional().safeParse(rawNote);
  const parsed = NavigateProposal.safeParse(rest);
  if (!parsed.success || !note.success) {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        message: 'expected { path: "/kanban", params?: { key: value }, note? }',
        issues: !parsed.success ? parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`) : [],
      },
    };
  }
  const { problems, warnings } = validateNavigateProposal(parsed.data, ownerPluginPages(caller, plugins), ownerCorePages(caller, plugins));
  if (problems.length) return { status: 400, body: { error: 'invalid_proposal', problems } };
  // Under a live tour of THIS mission the page opens at once; the grant is the owner's
  // browser action, never a field of the request.
  if (direct && liveGrant(caller.owner.id, caller.mission.id)) {
    bus.publish({ kind: 'ui_navigate', ownerUserId: caller.owner.id, path: parsed.data.path, params: parsed.data.params ?? {} });
    audit('navigate.direct', caller.mission.id);
    return {
      status: 200,
      body: {
        status: 'navigated',
        message: 'The page was opened on the user\'s screen (guided tour).',
        ...(warnings.length ? { warnings } : {}),
      },
    };
  }
  const row = createLayoutProposal({
    id: randomUUID(),
    kind: NAVIGATE_KIND,
    mission: caller.mission,
    owner: caller.owner,
    payload: parsed.data,
    note: note.data ?? null,
    origin,
  });
  audit('navigate.propose', row.id);
  return {
    status: 202,
    body: {
      id: row.id,
      status: 'pending',
      message: PROPOSAL_PENDING_REPLY,
      ...(warnings.length ? { warnings } : {}),
      proposal: layoutProposalView(row).payload,
    },
  };
}

function send(res: Response, reply: Reply): void {
  res.status(reply.status).json(reply.body);
}

export type NavigateRouteOptions = {
  /** The installation's plugins; a test supplies its own. */
  plugins?: (req: Request) => PluginPublic[];
};

export function registerNavigateRoutes(app: Router, opts: NavigateRouteOptions = {}): void {
  const pluginsOf = opts.plugins ?? ((req: Request) => galleryPlugins(loaderFromApp(req.app)));

  registerProposalKind(NAVIGATE_KIND, {
    label: 'navigation',
    revalidate: (payload) => {
      const parsed = NavigateProposal.safeParse(payload);
      if (!parsed.success) return [{ code: 'invalid_payload', message: 'the stored proposal no longer parses' }];
      return validateNavigateProposal(parsed.data).problems;
    },
  });

  app.get('/api/navigate/routes', (req, res) => {
    const caller = callerOf(req, res, 'read');
    if (!caller) return;
    const plugins = pluginsOf(req);
    res.json({
      routes: describeRoutes(ownerPluginPages(caller, plugins), ownerCorePages(caller, plugins)),
      note: 'origin "core" pages are the product\'s pages the user can open; "bundled" and "third-party" pages come from a plugin the user can open, '
        + 'and take no declared parameters.',
    });
  });

  // The owner starts a guided tour: THIS mission may move the screen, for a while.
  app.post('/api/navigate/grant', (req, res) => {
    const auth = req.auth;
    if (!auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (!isPersonAuth(auth) || !auth.user) {
      forbidden(req, res, { kind: 'scope', reason: 'a guided tour is started from a signed-in browser, never by an agent' });
      return;
    }
    const body = GrantBody.safeParse(req.body ?? {});
    if (!body.success) { res.status(400).json(apiError('invalid_request', 'invalid_request')); return; }
    // The mission must be this account's own, through the same viewer as every mission read.
    const mission = scopedDb(viewerFromRequest(req)).getMission(body.data.missionId);
    if (!mission || mission.owner_user_id !== auth.user.id) { res.status(404).json(apiError('not_found', 'not_found')); return; }
    const until = Date.now() + (body.data.minutes ?? 30) * 60_000;
    dbApi.uiLayoutSet(auth.user.id, NAVIGATE_GRANT_SCOPE, JSON.stringify({ missionId: mission.id, until }));
    auditRequest(req, 'navigate.grant', mission.id);
    res.json({ ok: true, missionId: mission.id, until });
  });

  app.delete('/api/navigate/grant', (req, res) => {
    const auth = req.auth;
    if (!auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (!isPersonAuth(auth) || !auth.user) {
      forbidden(req, res, { kind: 'scope', reason: 'only the account itself revokes a guided tour' });
      return;
    }
    dbApi.uiLayoutSet(auth.user.id, NAVIGATE_GRANT_SCOPE, JSON.stringify({ missionId: '', until: 0 }));
    auditRequest(req, 'navigate.revoke', null);
    res.json({ ok: true });
  });

  app.post('/api/navigate/proposals', (req, res) => {
    const auth = req.auth;
    if (!auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (auth.kind !== 'api-token' || !auth.missionId) {
      forbidden(req, res, {
        kind: 'scope',
        reason: 'only an agent mission can propose a navigation',
        hint: 'A proposal is raised by an agent; the user navigates by themselves.',
      });
      return;
    }
    const caller = callerOf(req, res, 'write');
    if (!caller?.mission) return;
    send(res, proposeNavigate({ owner: caller.owner, mission: caller.mission }, (req.body ?? {}) as Record<string, unknown>,
      pluginsOf(req), (action, target) => auditRequest(req, action, target), true));
  });
}
