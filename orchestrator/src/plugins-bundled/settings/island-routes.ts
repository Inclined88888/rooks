/**
 * The island workspace, as an agent reaches it: read it (`islands_get`) and
 * propose another arrangement (`islands_propose`). Plus the snapshot of the
 * registered content types the owner's browser publishes, without which the
 * daemon would know neither their titles nor their params. Saving a preset
 * is the view's preset (`POST /api/widgets/presets`): it captures the
 * `.islands` row with the rest of the view.
 *
 * Whose workspace: always the account behind the caller — the mission's owner
 * for an agent, the signed-in user for a browser (`callerOf`). Changing the
 * screen is a proposal the owner applies from a card (`layout-proposals.ts`,
 * kind `islands`), the same card as the widget arrangements. The account's
 * named arrangements (`islands_arrangements_list` / `islands_arrangement_save`)
 * are written directly, like a preset: saving one changes nothing on screen.
 */
import type { Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dbApi, type MissionRow, type UserRow } from '../../db.js';
import { galleryPlugins, loaderFromApp } from '../../plugins/runtime.js';
import type { PluginPublic } from '../../plugins/public.js';
import { auditRequest } from '../../users/audit-actor.js';
import { forbidden, isPersonAuth } from '../../users/identity.js';
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
  HOST_ROUTE,
  ISLAND_LIMITS,
  ISLAND_PROPOSAL_MAX_BYTES,
  ISLAND_SNAPSHOT_MAX_BYTES,
  ISLAND_SNAPSHOT_SCOPE,
  ISLANDS_SUFFIX,
  IslandSnapshotBody,
  IslandsProposal,
  describeTree,
  leavesOf,
  parseIslandsProposal,
  readIslandSnapshot,
  readStoredTree,
  snapshotTypes,
  validateIslandsProposal,
  visibleTypes,
  defaultStoredTree,
  presetStoredTree,
  type StoredIslandSnapshot,
  type StoredTree,
} from './island-model.js';
import {
  ARRANGEMENTS_SUFFIX,
  MAX_ARRANGEMENTS,
  arrangementHref,
  readArrangements,
  saveArrangement,
  storedTreeFromLayout,
  summariseArrangement,
  writeArrangements,
  type StoredArrangement,
} from './island-arrangements.js';
import { allowedFor, callerOf, storedJson, targetOf, widgetPartProblems, type Caller } from './widget-routes.js';
import { MAX_PRESET_NAME, ViewPath, workspaceKey, type ProposalProblem } from './widget-model.js';
import { apiError } from '../../api-error.js';

export const ISLANDS_KIND = 'islands';
/** A named arrangement recalled on a view (`islands_propose { arrangement }`): the browser lays it with `recallArrangement`. */
export const ISLAND_ARRANGEMENT_KIND = 'island-arrangement';

function snapshotOf(owner: UserRow): StoredIslandSnapshot | null {
  // The owner's own row only: the machine template (`owner=''`) is nobody's catalog.
  return readIslandSnapshot(dbApi.uiLayoutGetOwn(owner.id, ISLAND_SNAPSHOT_SCOPE)?.value);
}

function treeOf(owner: string, view: string, project: string | null): StoredTree {
  return readStoredTree(storedJson(owner, `${workspaceKey(owner, view, project)}.${ISLANDS_SUFFIX}`));
}

const Target = z.object({
  view: ViewPath.optional(),
  /** `''` = no project. */
  project: z.string().regex(/^([A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/).optional(),
}).strict();

/** `GET /api/islands`: the island workspace of a view, as the owner may see it. */
export function readIslands(caller: Caller, rawQuery: unknown, plugins: readonly PluginPublic[]): Reply {
  const q = Target.safeParse(rawQuery);
  if (!q.success) return { status: 400, body: { error: 'invalid_request', message: 'expected ?view=/path&project=slug' } };
  const { view, project } = targetOf(caller, q.data.view, q.data.project);
  const snapshot = snapshotOf(caller.owner);
  const types = visibleTypes(snapshot, allowedFor(caller.owner, plugins));
  const tree = treeOf(caller.owner.id, view, project);
  const titleOf = (type: string) => types.find((t) => t.type === type)?.title ?? null;
  return {
    status: 200,
    body: {
      view,
      project,
      customised: tree.customised,
      focus: tree.focus,
      ...(tree.customised ? {} : { note: 'Nothing was arranged on this view: one island holds its page. Open a content against its edges, or propose a whole layout.' }),
      tree: describeTree(tree, titleOf),
      islands: leavesOf(tree.root).length,
      limits: ISLAND_LIMITS,
      snapshotAt: snapshot?.at ?? null,
      ...(snapshot ? {} : { warning: 'The owner has not opened Timon in a browser since this version: the content types are unknown.' }),
      types: [
        { type: HOST_ROUTE, title: 'The page of the view', params: {}, note: 'Exactly once in a layout; never opened again.' },
        ...types.map((t) => ({
          type: t.type,
          title: t.title,
          plugin: t.type.slice(0, t.type.lastIndexOf(':')),
          params: t.params ?? null,
          ...(t.singletonBy ? { singletonBy: t.singletonBy } : {}),
          ...(t.volatileParams?.length ? { volatileParams: t.volatileParams } : {}),
        })),
      ],
    },
  };
}

/** `POST /api/islands/proposals`: validates the layout and raises its card in the caller's mission. */
export function proposeIslands(
  caller: Caller & { mission: MissionRow },
  raw: Record<string, unknown>,
  plugins: readonly PluginPublic[],
  audit: AuditFn,
  origin?: ProposalOrigin,
): Reply {
  if (Buffer.byteLength(JSON.stringify(raw)) > ISLAND_PROPOSAL_MAX_BYTES) {
    return { status: 413, body: { error: 'too_large', message: `a proposal is at most ${ISLAND_PROPOSAL_MAX_BYTES} bytes` } };
  }
  const { note: rawNote, ...rest } = raw;
  const note = z.string().max(300).optional().safeParse(rawNote);
  const target = targetOf(caller, typeof rest.view === 'string' ? rest.view : undefined,
    rest.project === null ? '' : typeof rest.project === 'string' ? rest.project : undefined);
  const parsed = parseIslandsProposal({ ...rest, view: target.view, project: target.project });
  if (!parsed?.success || !note.success) {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        message: 'expected { view?, project?, layout: { root, focus? } | open: { content: { type, params? }, edge, island? }, widgets?: { zones?, columns?, remove? }, note? }',
        issues: parsed && !parsed.success ? parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`) : [],
      },
    };
  }
  const proposal = parsed.data;
  const { problems, warnings } = validateIslandsProposal(proposal, {
    snapshot: snapshotOf(caller.owner),
    current: treeOf(caller.owner.id, proposal.view, proposal.project ?? null),
    allowed: allowedFor(caller.owner, plugins),
  });
  // Every extra scope is checked as if proposed on its own: a column a
  // project's view cannot hold is refused there too.
  if (proposal.widgets) {
    for (const project of scopesOf(proposal)) {
      problems.push(...widgetPartProblems(caller.owner, { view: proposal.view, project }, proposal.widgets, plugins));
    }
  }
  if (problems.length) {
    const status = problems.some((p) => p.code === 'no_snapshot') ? 409 : 400;
    return { status, body: { error: 'invalid_proposal', problems } };
  }
  const row = createLayoutProposal({
    id: randomUUID(),
    kind: ISLANDS_KIND,
    mission: caller.mission,
    owner: caller.owner,
    payload: proposal,
    note: note.data ?? null,
    origin,
  });
  audit('islands.propose', row.id);
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

/** The account's row of named arrangements (`sharedArrangementsScope` of the app). */
function arrangementsScope(owner: string): string {
  return `${workspaceKey(owner, '', null)}.${ARRANGEMENTS_SUFFIX}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function titleFor(owner: UserRow, plugins: readonly PluginPublic[]): (type: string) => string | null {
  // Titles of the types the owner may see only: a list must not name what `islands_get` would hide.
  const types = visibleTypes(snapshotOf(owner), allowedFor(owner, plugins));
  return (type) => types.find((t) => t.type === type)?.title ?? null;
}

function arrangementView(a: StoredArrangement, titleOf: (type: string) => string | null, full: boolean): Record<string, unknown> {
  return {
    id: a.id,
    name: a.name,
    createdAt: a.createdAt,
    menu: a.menu,
    href: arrangementHref(a.id),
    summary: summariseArrangement(a.tree, titleOf),
    ...(full ? { tree: describeTree(readStoredTree(a.tree), titleOf) } : {}),
  };
}

const ArrangementsQuery = z.object({ full: z.enum(['0', '1', 'true', 'false']).optional() }).strict();

/** `GET /api/islands/arrangements`: the owner's named arrangements, summarised (`?full=1`: each tree). */
export function listArrangements(caller: Caller, rawQuery: unknown, plugins: readonly PluginPublic[]): Reply {
  const q = ArrangementsQuery.safeParse(rawQuery);
  if (!q.success) return { status: 400, body: { error: 'invalid_request', message: 'expected ?full=1 or nothing' } };
  const full = q.data.full === '1' || q.data.full === 'true';
  const owner = caller.owner.id;
  const scope = arrangementsScope(owner);
  const titleOf = titleFor(caller.owner, plugins);
  return {
    status: 200,
    body: {
      arrangements: readArrangements(storedJson(owner, scope)).map((a) => arrangementView(a, titleOf, full)),
      limits: { arrangements: MAX_ARRANGEMENTS, nameLength: MAX_PRESET_NAME },
      updatedAt: dbApi.uiLayoutGet(owner, scope)?.updated_at ?? null,
    },
  };
}

const ArrangementBody = z.object({
  name: z.string().min(1).max(200),
  replace: z.boolean().optional(),
  view: ViewPath.optional(),
  /** `''` or `null` = no project. */
  project: z.string().regex(/^([A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/).nullable().optional(),
  /** Read by `parseIslandsProposal`, whose nesting bound comes before zod recurses. */
  layout: z.unknown().optional(),
}).strict().refine((b) => b.layout === undefined || (b.view === undefined && b.project === undefined),
  '`layout` names its own tree: no `view` nor `project` with it');

const ARRANGEMENT_ERRORS: Record<string, { status: number; message: string }> = {
  'empty-name': { status: 400, message: 'an arrangement needs a name' },
  'empty-tree': { status: 409, message: 'this view shows nothing but its page: there is no arrangement to keep' },
  'duplicate-name': { status: 409, message: 'an arrangement of that name exists: pass replace=true to give it this tree' },
  'too-many': { status: 409, message: `the account already holds ${MAX_ARRANGEMENTS} arrangements: the user deletes one from the Island arrangements menu first` },
  'too-large': { status: 413, message: 'the arrangements of this account would exceed 64 KiB' },
};

/**
 * `POST /api/islands/arrangements`: keeps a tree under a name in the owner's
 * list — the view's `.islands` row (without the day's state, as a preset
 * captures it), or a `layout` checked like a proposal's. Written directly:
 * nothing changes on screen, and it is never put in the menu.
 */
export function saveIslandArrangement(caller: Caller, rawBody: unknown, plugins: readonly PluginPublic[], audit: AuditFn): Reply {
  if (Buffer.byteLength(JSON.stringify(rawBody ?? {})) > ISLAND_PROPOSAL_MAX_BYTES) {
    return { status: 413, body: { error: 'too_large', message: `a request is at most ${ISLAND_PROPOSAL_MAX_BYTES} bytes` } };
  }
  const body = ArrangementBody.safeParse(rawBody ?? {});
  if (!body.success) {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        message: 'expected { name, replace?, view?, project? } or { name, replace?, layout: { root, focus? } }',
        issues: body.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    };
  }
  const owner = caller.owner.id;
  const scope = arrangementsScope(owner);
  const snapshot = snapshotOf(caller.owner);
  const warnings: string[] = [];
  let tree: unknown;
  let from: Record<string, unknown>;
  if (body.data.layout !== undefined) {
    // Checked exactly as `islands_propose` with the same layout: an
    // arrangement the user recalls later must open what the card would.
    const parsed = parseIslandsProposal({ view: '/', layout: body.data.layout });
    if (!parsed?.success) {
      return {
        status: 400,
        body: {
          error: 'invalid_request',
          message: 'expected layout: { root, focus? } — see islands_propose',
          issues: parsed ? parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`) : [],
        },
      };
    }
    const checked = validateIslandsProposal(parsed.data, { snapshot, current: defaultStoredTree(), allowed: allowedFor(caller.owner, plugins) });
    if (checked.problems.length) {
      const status = checked.problems.some((p) => p.code === 'no_snapshot') ? 409 : 400;
      return { status, body: { error: 'invalid_layout', problems: checked.problems } };
    }
    warnings.push(...checked.warnings);
    tree = storedTreeFromLayout(parsed.data.layout!);
    from = { layout: true };
  } else {
    const { view, project } = targetOf(caller, body.data.view, body.data.project === null ? '' : body.data.project);
    tree = storedJson(owner, `${workspaceKey(owner, view, project)}.${ISLANDS_SUFFIX}`);
    if (!snapshot) warnings.push('The owner has not opened Timon in a browser since this version: the day\'s state of each tab is removed when the arrangement is recalled.');
    from = { view, project };
  }
  // A day's state never enters an arrangement: recalling it brings the agents back, never the conversations.
  const stored = presetStoredTree(tree, snapshot?.types ?? []);
  // Nothing stored for the view: it shows its page alone, the default tree is never written.
  const saved = isRecord(stored)
    ? saveArrangement(readArrangements(storedJson(owner, scope)), body.data.name, stored,
      { replace: body.data.replace === true, id: randomUUID(), now: Date.now() })
    : { ok: false as const, error: 'empty-tree' as const };
  if (!saved.ok) {
    const refusal = ARRANGEMENT_ERRORS[saved.error]!;
    return { status: refusal.status, body: { error: saved.error, message: refusal.message } };
  }
  // Moves the row's version: a menu left on the old copy sees the conflict and reads again (`expected=`).
  const updatedAt = dbApi.uiLayoutSet(owner, scope, writeArrangements(saved.arrangements));
  audit('islands.arrangement.save', saved.arrangement.id);
  return {
    status: 200,
    body: {
      ok: true,
      replaced: saved.replaced,
      from,
      arrangement: arrangementView(saved.arrangement, titleFor(caller.owner, plugins), false),
      updatedAt,
      ...(warnings.length ? { warnings } : {}),
    },
  };
}

/** The owner's own arrangement of that id — never another account's row, nor the machine template. */
function ownArrangement(owner: string, id: string): StoredArrangement | null {
  const row = dbApi.uiLayoutGetOwn(owner, arrangementsScope(owner));
  if (!row) return null;
  let raw: unknown = null;
  try { raw = JSON.parse(row.value) as unknown; } catch { return null; }
  return readArrangements(raw).find((a) => a.id === id) ?? null;
}

const ArrangementId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

/**
 * The body of a recall. Strict: an arrangement is a whole workspace already,
 * so nothing else of a proposal (`layout`, `open`, `widgets`,
 * `also_projects`) goes with it.
 */
const ArrangementProposalBody = z.object({
  arrangement: ArrangementId,
  view: ViewPath.optional(),
  /** `''` or `null` = no project. */
  project: z.string().regex(/^([A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/).nullable().optional(),
  note: z.string().max(300).optional(),
}).strict();

/** What the card holds: the name is a reminder for the preview, the id is what is recalled. */
export const ArrangementProposal = z.object({
  arrangement: ArrangementId,
  name: z.string(),
  view: ViewPath,
  project: z.string().nullable(),
}).strict();
export type ArrangementProposal = z.infer<typeof ArrangementProposal>;

function arrangementGone(id: string): ProposalProblem {
  return { code: 'unknown_arrangement', message: `no arrangement ${id} in this account: islands_arrangements_list gives the ids` };
}

/**
 * `POST /api/islands/proposals` with `arrangement`: a card that lays one of
 * the owner's named arrangements on a view. The id is looked up in the
 * owner's own list only; an id of another account reads as one that does not
 * exist, so the answer says nothing of it.
 */
export function proposeArrangementRecall(
  caller: Caller & { mission: MissionRow },
  raw: Record<string, unknown>,
  plugins: readonly PluginPublic[],
  audit: AuditFn,
): Reply {
  if (Buffer.byteLength(JSON.stringify(raw)) > ISLAND_PROPOSAL_MAX_BYTES) {
    return { status: 413, body: { error: 'too_large', message: `a proposal is at most ${ISLAND_PROPOSAL_MAX_BYTES} bytes` } };
  }
  const body = ArrangementProposalBody.safeParse(raw);
  if (!body.success) {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        message: 'expected { arrangement, view?, project?, note? } — an arrangement is the whole workspace: no layout, open, widgets nor also_projects with it',
        issues: body.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    };
  }
  const found = ownArrangement(caller.owner.id, body.data.arrangement);
  if (!found) return { status: 404, body: { error: 'unknown_arrangement', problems: [arrangementGone(body.data.arrangement)] } };
  const { view, project } = targetOf(caller, body.data.view, body.data.project === null ? '' : body.data.project);
  const payload: ArrangementProposal = { arrangement: found.id, name: found.name, view, project };
  const row = createLayoutProposal({
    id: randomUUID(),
    kind: ISLAND_ARRANGEMENT_KIND,
    mission: caller.mission,
    owner: caller.owner,
    payload,
    note: body.data.note ?? null,
  });
  audit('islands.arrangement.propose', row.id);
  return {
    status: 202,
    body: {
      id: row.id,
      status: 'pending',
      message: PROPOSAL_PENDING_REPLY,
      proposal: layoutProposalView(row).payload,
      arrangement: arrangementView(found, titleFor(caller.owner, plugins), false),
    },
  };
}

function send(res: Response, reply: Reply): void {
  res.status(reply.status).json(reply.body);
}

export type IslandRouteOptions = {
  /** Tests stand in for the plugin loader. */
  plugins?: (req: Request) => PluginPublic[];
};

/** The projects one Apply sets up: the proposal's own, then `also_projects` (`''` = none). */
function scopesOf(p: IslandsProposal): (string | null)[] {
  return [p.project ?? null, ...(p.also_projects ?? []).map((project) => project || null)];
}

export function registerIslandRoutes(app: Router, opts: IslandRouteOptions = {}): void {
  const pluginsOf = opts.plugins ?? ((req: Request) => galleryPlugins(loaderFromApp(req.app)));

  registerProposalKind(ISLANDS_KIND, {
    label: 'island layout',
    revalidate: (payload, owner, req) => {
      const parsed = IslandsProposal.safeParse(payload);
      if (!parsed.success) return [{ code: 'invalid_payload', message: 'the stored proposal no longer parses' }];
      const p = parsed.data;
      return [
        ...validateIslandsProposal(p, {
          snapshot: snapshotOf(owner),
          current: treeOf(owner.id, p.view, p.project ?? null),
          allowed: allowedFor(owner, pluginsOf(req)),
        }).problems,
        ...(p.widgets
          ? scopesOf(p).flatMap((project) => widgetPartProblems(owner, { view: p.view, project }, p.widgets!, pluginsOf(req)))
          : []),
      ];
    },
  });

  registerProposalKind(ISLAND_ARRANGEMENT_KIND, {
    label: 'island arrangement',
    // Deleted between the proposal and the click: the claim is refused, nothing is written.
    revalidate: (payload, owner) => {
      const parsed = ArrangementProposal.safeParse(payload);
      if (!parsed.success) return [{ code: 'invalid_payload', message: 'the stored proposal no longer parses' }];
      return ownArrangement(owner.id, parsed.data.arrangement)
        ? []
        : [{ code: 'arrangement_deleted', message: `the arrangement "${parsed.data.name}" was deleted since the proposal` }];
    },
  });

  // The owner's browser hands over what only it knows: the registered types, their titles and params.
  app.put('/api/islands/snapshot', (req, res) => {
    const auth = req.auth;
    if (!auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (!isPersonAuth(auth) || !auth.user) {
      forbidden(req, res, { kind: 'scope', reason: 'the island content types are published by a signed-in browser' });
      return;
    }
    if (Buffer.byteLength(JSON.stringify(req.body ?? {})) > ISLAND_SNAPSHOT_MAX_BYTES) {
      res.status(413).json({ error: 'too_large' });
      return;
    }
    const body = IslandSnapshotBody.safeParse(req.body ?? {});
    if (!body.success) { res.status(400).json(apiError('invalid_request', 'invalid_request')); return; }
    const types = snapshotTypes(body.data);
    dbApi.uiLayoutSet(auth.user.id, ISLAND_SNAPSHOT_SCOPE, JSON.stringify({ types, at: Date.now() }));
    res.json({ ok: true, kept: types.length, dropped: body.data.types.length - types.length });
  });

  app.get('/api/islands', (req, res) => {
    const caller = callerOf(req, res, 'read');
    if (!caller) return;
    send(res, readIslands(caller, req.query, pluginsOf(req)));
  });

  app.get('/api/islands/arrangements', (req, res) => {
    const caller = callerOf(req, res, 'read');
    if (!caller) return;
    send(res, listArrangements(caller, req.query, pluginsOf(req)));
  });

  app.post('/api/islands/arrangements', (req, res) => {
    const caller = callerOf(req, res, 'write');
    if (!caller) return;
    send(res, saveIslandArrangement(caller, req.body, pluginsOf(req), (action, target) => auditRequest(req, action, target)));
  });

  app.post('/api/islands/proposals', (req, res) => {
    const auth = req.auth;
    if (!auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    // Only an agent, through its own mission's token: the card lives in that mission's conversation.
    if (auth.kind !== 'api-token' || !auth.missionId) {
      forbidden(req, res, {
        kind: 'scope',
        reason: 'only an agent mission can propose an island layout',
        hint: 'Arrange the islands yourself by dragging their tabs; a proposal is raised by an agent.',
      });
      return;
    }
    const caller = callerOf(req, res, 'write');
    if (!caller?.mission) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.arrangement !== undefined) {
      send(res, proposeArrangementRecall({ owner: caller.owner, mission: caller.mission }, body,
        pluginsOf(req), (action, target) => auditRequest(req, action, target)));
      return;
    }
    send(res, proposeIslands({ owner: caller.owner, mission: caller.mission }, (req.body ?? {}) as Record<string, unknown>,
      pluginsOf(req), (action, target) => auditRequest(req, action, target)));
  });
}
