/**
 * The side menu, as an agent reaches it: read which pages are hidden and how
 * the menu is laid out (`nav_get`), and propose another set or layout
 * (`nav_propose`). Like every change of the
 * screen, a proposal is a card the owner applies from the mission's
 * conversation (`layout-proposals.ts`, kind `nav`); the browser writes the row.
 */
import type { Response, Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dbApi, type MissionRow } from '../../db.js';
import { auditRequest } from '../../users/audit-actor.js';
import { forbidden } from '../../users/identity.js';
import {
  createLayoutProposal,
  layoutProposalView,
  PROPOSAL_PENDING_REPLY,
  registerProposalKind,
  type AuditFn,
  type ProposalOrigin,
  type Reply,
} from './layout-proposals.js';
import {
  NAV_PAGES,
  NAV_PROPOSAL_MAX_BYTES,
  NAV_SEPARATOR,
  NavProposal,
  readHiddenNav,
  readNavLayout,
  sharedNavKey,
  validateNavProposal,
} from './nav-model.js';
import { callerOf, type Caller } from './widget-routes.js';

export const NAV_KIND = 'nav';

/** `GET /api/nav`: the pages the owner hid from the menu, and the layout they gave it. */
export function readNav(caller: Caller): Reply {
  const raw = dbApi.uiLayoutGetOwn(caller.owner.id, sharedNavKey(caller.owner.id))?.value;
  return {
    status: 200,
    body: {
      hidden: readHiddenNav(raw),
      ...readNavLayout(raw),
      separator: NAV_SEPARATOR,
      pages: NAV_PAGES,
      note: 'Pages added by plugins are not listed; their path can be hidden or placed too. A hidden page still opens by its address. '
        + '`order` is the main list top to bottom, `footer` the bottom of the menu above Settings, both made of paths and separators; '
        + '`null` means the person never laid it out (the product\'s order, one separator before Activity). '
        + 'A page neither list names shows at the end of the main list.',
    },
  };
}

/** `POST /api/nav/proposals`: validates the set of hidden pages and raises its card in the caller's mission. */
export function proposeNav(
  caller: Caller & { mission: MissionRow },
  raw: Record<string, unknown>,
  audit: AuditFn,
  origin?: ProposalOrigin,
): Reply {
  if (Buffer.byteLength(JSON.stringify(raw)) > NAV_PROPOSAL_MAX_BYTES) return { status: 413, body: { error: 'too_large' } };
  const { note: rawNote, ...rest } = raw;
  const note = z.string().max(300).optional().safeParse(rawNote);
  const parsed = NavProposal.safeParse(rest);
  if (!parsed.success || !note.success) {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        message: 'expected { hidden?: ["/kanban", …], order?: ["/", "---", …], footer?: [...], note? } — at least one list, each complete',
        issues: !parsed.success ? parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`) : [],
      },
    };
  }
  const { problems, warnings } = validateNavProposal(parsed.data);
  if (problems.length) return { status: 400, body: { error: 'invalid_proposal', problems } };
  const row = createLayoutProposal({
    id: randomUUID(),
    kind: NAV_KIND,
    mission: caller.mission,
    owner: caller.owner,
    payload: parsed.data,
    note: note.data ?? null,
    origin,
  });
  audit('nav.propose', row.id);
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

export function registerNavRoutes(app: Router): void {
  registerProposalKind(NAV_KIND, {
    label: 'menu',
    revalidate: (payload) => {
      const parsed = NavProposal.safeParse(payload);
      if (!parsed.success) return [{ code: 'invalid_payload', message: 'the stored proposal no longer parses' }];
      return validateNavProposal(parsed.data).problems;
    },
  });

  app.get('/api/nav', (req, res) => {
    const caller = callerOf(req, res, 'read');
    if (!caller) return;
    send(res, readNav(caller));
  });

  app.post('/api/nav/proposals', (req, res) => {
    const auth = req.auth;
    if (!auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (auth.kind !== 'api-token' || !auth.missionId) {
      forbidden(req, res, {
        kind: 'scope',
        reason: 'only an agent mission can propose a menu',
        hint: 'A proposal is raised by an agent; the user hides pages from the menu itself.',
      });
      return;
    }
    const caller = callerOf(req, res, 'write');
    if (!caller?.mission) return;
    send(res, proposeNav({ owner: caller.owner, mission: caller.mission }, (req.body ?? {}) as Record<string, unknown>,
      (action, target) => auditRequest(req, action, target)));
  });
}
