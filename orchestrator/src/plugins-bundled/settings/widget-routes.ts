/**
 * The widget arrangement, as an agent reaches it: read it (`widgets_get`),
 * propose another one (`widgets_propose`), save it as a named preset
 * (`widgets_preset_save`). Plus the catalog snapshot the owner's browser
 * publishes, without which the daemon would not know a widget's title.
 *
 * Whose arrangement: always the account behind the caller — the mission's
 * owner for an agent, the signed-in user for a browser. Never a parameter.
 * Changing the screen is a proposal the owner applies (`layout-proposals.ts`);
 * saving a preset writes the owner's own presets row, directly, as decided.
 */
import type { Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getAgent } from '../../agent.js';
import { dbApi, type MissionRow, type UserRow } from '../../db.js';
import { galleryPlugins, loaderFromApp } from '../../plugins/runtime.js';
import type { PluginPublic } from '../../plugins/public.js';
import { auditRequest } from '../../users/audit-actor.js';
import { forbidden, viewerFromRequest, isPersonAuth } from '../../users/identity.js';
import { scopedDb } from '../../users/scoped-db.js';
import type { DbViewer } from '../../users/owned.js';
import { pluginVisible } from '../../users/surfaces.js';
import {
  createLayoutProposal,
  layoutProposalView,
  PROPOSAL_PENDING_REPLY,
  registerProposalKind,
  type AuditFn,
  type ProposalOrigin,
  type Reply,
} from './layout-proposals.js';
import { ISLAND_SNAPSHOT_SCOPE, ISLANDS_SUFFIX, presetStoredTree, readIslandSnapshot } from './island-model.js';
import { LAYOUT_MAX_BYTES } from './routes.js';
import {
  CHAT_COLUMNS,
  COLUMNS_SUFFIX,
  PRESETS_SUFFIX,
  PRODUCT_VIEWS,
  PROPOSAL_MAX_BYTES,
  SNAPSHOT_SCOPE,
  SnapshotBody,
  ViewPath,
  WIDGETS_SUFFIX,
  WidgetsProposal,
  captureRows,
  mergeSnapshot,
  placementsOf,
  readColumns,
  readPresets,
  readSnapshot,
  savePreset,
  sharedPresetsKey,
  validateWidgetsProposal,
  visibleCatalog,
  workspaceKey,
  zonesOfView,
  type ColumnsState,
  type PluginAllowed,
  type ProposalProblem,
  type StoredSnapshot,
} from './widget-model.js';
import { apiError } from '../../api-error.js';

/** A catalog of a few hundred cards with their starters stays far below this. */
const SNAPSHOT_MAX_BYTES = 192 * 1024;

export const WIDGETS_KIND = 'widgets';

/** A route answers with a `Reply`; the cores below are shared with the plugin facade. */
function send(res: Response, reply: Reply): void {
  res.status(reply.status).json(reply.body);
}

export type Caller = { owner: UserRow; mission: MissionRow | null };

/**
 * The account a request acts for. An agent acts for its mission's owner, and
 * only through its own mission token; a browser for its signed-in user. The
 * daemon token (the operator's CLI) may read the operator's arrangement, never
 * write it: it names no account of its own.
 */
export function callerOf(req: Request, res: Response, mode: 'read' | 'write'): Caller | null {
  const auth = req.auth;
  if (!auth) { res.status(401).json({ error: 'unauthorized' }); return null; }
  if (auth.kind === 'api-token' && auth.missionId) {
    // Through the token's own viewer, like every route reading a mission.
    const mission = scopedDb(viewerFromRequest(req)).getMission(auth.missionId);
    const owner = mission?.owner_user_id ? dbApi.getUserById(mission.owner_user_id) : undefined;
    if (!mission || !owner) {
      res.status(409).json({ error: 'no_owner', message: 'this mission has no owner account whose screen it could arrange' });
      return null;
    }
    // The token speaks for the account that launched the mission: anything else is not this owner's.
    if ((auth.user && auth.user.id !== owner.id) || owner.status !== 'active') {
      forbidden(req, res, { kind: 'scope', reason: 'this mission does not act for its owner account' });
      return null;
    }
    return { owner, mission };
  }
  if (isPersonAuth(auth) && auth.user) return { owner: auth.user, mission: null };
  if (auth.kind === 'daemon-token' && mode === 'read' && auth.user) return { owner: auth.user, mission: null };
  forbidden(req, res, {
    kind: 'account_required',
    reason: 'the widget arrangement belongs to an account',
    hint: 'Call it from an agent mission (its owner\'s screen) or from a signed-in browser.',
  });
  return null;
}

/** The owner's own grants, as the surface curtain reads them. Never the mission token's cap. */
export function ownerViewer(owner: UserRow): DbViewer {
  return {
    id: owner.id,
    isSuperadmin: owner.is_superadmin,
    permissions: owner.is_superadmin ? [] : dbApi.listPermissionsForUser(owner.id),
  };
}

/** What the owner may see: an active plugin their grants open. Never the mission token's cap. */
export function allowedFor(owner: UserRow, plugins: readonly PluginPublic[]): PluginAllowed {
  const viewer = ownerViewer(owner);
  const byId = new Map(plugins.map((p) => [p.id, p]));
  return (pluginId) => {
    const plugin = byId.get(pluginId);
    return !!plugin && plugin.state === 'active' && pluginVisible(plugin, viewer);
  };
}

function snapshotOf(owner: UserRow): StoredSnapshot | null {
  // The owner's own row only: the machine template (`owner=''`) is nobody's catalog.
  return readSnapshot(dbApi.uiLayoutGetOwn(owner.id, SNAPSHOT_SCOPE)?.value);
}

export function storedJson(owner: string, scope: string): unknown {
  const row = dbApi.uiLayoutGet(owner, scope);
  if (!row) return null;
  try { return JSON.parse(row.value) as unknown; } catch { return null; }
}

const Target = z.object({
  view: ViewPath.optional(),
  /** `''` = no project. */
  project: z.string().regex(/^([A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/).optional(),
}).strict();

/**
 * The view an agent means when it says nothing: the chat of its own mission,
 * under its agent's project — the one the card is shown in. A browser means
 * the cockpit.
 */
export function targetOf(caller: Caller, view: string | undefined, project: string | null | undefined): { view: string; project: string | null } {
  const v = view ?? (caller.mission ? '/chat' : '/');
  if (project !== undefined) return { view: v, project: project || null };
  if (v !== '/chat' || !caller.mission) return { view: v, project: null };
  let agentProject: string | null = null;
  try { agentProject = getAgent(caller.mission.agent_name)?.project ?? null; } catch { agentProject = null; }
  return { view: v, project: agentProject };
}

/**
 * The widget part of an island proposal (`islands_propose` with `widgets`),
 * checked exactly as a `widgets_propose` on the same view would be.
 */
export function widgetPartProblems(
  owner: UserRow,
  target: { view: string; project: string | null },
  part: Omit<WidgetsProposal, 'view' | 'project'>,
  plugins: readonly PluginPublic[],
): ProposalProblem[] {
  if (!part.zones && !part.remove && !part.columns) return [{ code: 'empty_widgets', message: '`widgets` changes nothing' }];
  const proposal: WidgetsProposal = { ...part, view: target.view, project: target.project };
  const key = workspaceKey(owner.id, proposal.view, proposal.project ?? null);
  return validateWidgetsProposal(proposal, {
    snapshot: snapshotOf(owner),
    columns: columnsOf(owner.id, key, proposal.view),
    allowed: allowedFor(owner, plugins),
  });
}

function columnsOf(owner: string, key: string, view: string): ColumnsState | null {
  return view === '/chat' ? readColumns(storedJson(owner, `${key}.${COLUMNS_SUFFIX}`)) : null;
}

/** `GET /api/widgets`: the arrangement of a view, as the owner may see it. */
export function readWidgets(caller: Caller, rawQuery: unknown, plugins: readonly PluginPublic[]): Reply {
  const q = Target.safeParse(rawQuery);
  if (!q.success) return { status: 400, body: { error: 'invalid_request', message: 'expected ?view=/path&project=slug' } };
  const { view, project } = targetOf(caller, q.data.view, q.data.project);
  const owner = caller.owner.id;
  const snapshot = snapshotOf(caller.owner);
  const key = workspaceKey(owner, view, project);
  const columns = columnsOf(owner, key, view);
  const catalog = visibleCatalog(snapshot, allowedFor(caller.owner, plugins));
  const stored = storedJson(owner, `${key}.${WIDGETS_SUFFIX}`);
  const placed = placementsOf(stored, snapshot?.defaults[view], catalog);
  const zones = zonesOfView(view, snapshot, columns);
  const columnOfZone = (zone: string): string | null => CHAT_COLUMNS.find((c) => zone === c || zone.startsWith(`${c}#`)) ?? null;
  return {
    status: 200,
    body: {
      view,
      project,
      customised: stored !== null,
      known: placed.known,
      snapshotAt: snapshot?.at ?? null,
      ...(snapshot ? {} : { note: 'The owner has not opened Rooks in a browser since this version: titles and placements are unknown.' }),
      views: [...new Set([...PRODUCT_VIEWS, ...Object.keys(snapshot?.views ?? {})])],
      zones: zones.map((z) => ({
        id: z.id,
        slot: z.slot,
        orientation: z.orientation,
        ...(columnOfZone(z.id) ? { column: columnOfZone(z.id) } : {}),
        ...(columns?.names[z.id] ? { name: columns.names[z.id] } : {}),
        widgets: placed.byZone.get(z.id) ?? [],
      })),
      palette: placed.removed.map((id) => ({ id, title: catalog.find((w) => w.id === id)?.title ?? id })),
      catalog: catalog.map((w) => ({
        id: w.id,
        title: w.title,
        plugin: w.pluginId ?? null,
        ...(w.description ? { description: w.description } : {}),
        compact: w.bar === true,
        zones: zones.filter((z) => z.orientation === 'vertical' || w.bar === true).map((z) => z.id),
      })),
      columns,
    },
  };
}

/** `POST /api/widgets/proposals`: validates the arrangement and raises its card in the caller's mission. */
export function proposeWidgets(
  caller: Caller & { mission: MissionRow },
  raw: Record<string, unknown>,
  plugins: readonly PluginPublic[],
  audit: AuditFn,
  origin?: ProposalOrigin,
): Reply {
  if (Buffer.byteLength(JSON.stringify(raw)) > PROPOSAL_MAX_BYTES) {
    return { status: 413, body: { error: 'too_large', message: `a proposal is at most ${PROPOSAL_MAX_BYTES} bytes` } };
  }
  const { note: rawNote, ...rest } = raw;
  const note = z.string().max(300).optional().safeParse(rawNote);
  const target = targetOf(caller, typeof rest.view === 'string' ? rest.view : undefined,
    rest.project === null ? '' : typeof rest.project === 'string' ? rest.project : undefined);
  const parsed = WidgetsProposal.safeParse({ ...rest, view: target.view, project: target.project });
  if (!parsed.success || !note.success) {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        message: 'expected { view?, project?, zones?: {zone: [widget ids]}, remove?: [ids], columns?: {...}, note? }',
        issues: parsed.success ? [] : parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    };
  }
  const proposal = parsed.data;
  if (!proposal.zones && !proposal.remove && !proposal.columns) {
    return { status: 400, body: { error: 'empty_proposal', message: 'nothing to change' } };
  }
  const snapshot = snapshotOf(caller.owner);
  const key = workspaceKey(caller.owner.id, proposal.view, proposal.project ?? null);
  const problems = validateWidgetsProposal(proposal, {
    snapshot,
    columns: columnsOf(caller.owner.id, key, proposal.view),
    allowed: allowedFor(caller.owner, plugins),
  });
  if (problems.length) {
    const status = problems.some((p) => p.code === 'no_snapshot') ? 409 : 400;
    return { status, body: { error: 'invalid_proposal', problems } };
  }
  const row = createLayoutProposal({
    id: randomUUID(),
    kind: WIDGETS_KIND,
    mission: caller.mission,
    owner: caller.owner,
    payload: proposal,
    note: note.data ?? null,
    origin,
  });
  audit('widgets.propose', row.id);
  return { status: 202, body: { id: row.id, status: 'pending', message: PROPOSAL_PENDING_REPLY, proposal: layoutProposalView(row).payload } };
}

const PresetBody = z.object({
  name: z.string().min(1).max(200),
  view: ViewPath.optional(),
  project: z.string().regex(/^([A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/).nullable().optional(),
  replace: z.boolean().optional(),
}).strict();

/**
 * `POST /api/widgets/presets`: saves the view's current arrangement as a named
 * preset — directly, no card: it changes nothing on screen, and the menu can
 * delete it in a click. Same row, same format and same bounds as the "Layouts" menu.
 */
export function saveViewPreset(caller: Caller, rawBody: unknown, audit: AuditFn): Reply {
  const body = PresetBody.safeParse(rawBody ?? {});
  if (!body.success) return { status: 400, body: { error: 'invalid_request', message: 'expected { name, view?, project?, replace? }' } };
  const { view, project } = targetOf(caller, body.data.view, body.data.project === null ? '' : body.data.project);
  const owner = caller.owner.id;
  const key = workspaceKey(owner, view, project);
  const prefix = `${key}.`;
  // The owner's own catalog, as `islands_get` reads it: without one (no
  // browser opened since this version) the row is captured as is, and the
  // browser still cleans it when the preset is recalled.
  const types = readIslandSnapshot(dbApi.uiLayoutGetOwn(owner, ISLAND_SNAPSHOT_SCOPE)?.value)?.types ?? [];
  const scopes = captureRows(prefix, dbApi.uiLayoutList(owner, prefix), {
    [ISLANDS_SUFFIX]: (layout) => presetStoredTree(layout, types),
  });
  const sharedKey = sharedPresetsKey(owner, view);
  let presets = readPresets(storedJson(owner, sharedKey));
  // The menu folds a view's former per-project list into the shared one the
  // first time it finds that one empty; writing it first must not hide it.
  const legacyScope = `${key}.${PRESETS_SUFFIX}`;
  const folded = presets.length === 0 && dbApi.uiLayoutGet(owner, sharedKey) === undefined
    ? readPresets(storedJson(owner, legacyScope)) : [];
  presets = [...presets, ...folded].slice(0, 12);
  const saved = savePreset(presets, body.data.name, scopes, { replace: body.data.replace === true, id: randomUUID(), now: Date.now() });
  if (!saved.ok) {
    const message = saved.error === 'duplicate-name' ? 'a preset of that name exists: pass replace=true to overwrite it'
      : saved.error === 'too-many' ? 'this view already holds 12 presets: delete one from the Layouts menu first'
        : 'a preset needs a name';
    return { status: 409, body: { error: saved.error, message } };
  }
  const value = JSON.stringify({ v: 1, presets: saved.presets });
  // A presets row is a layout row like any other: same cap.
  if (Buffer.byteLength(value) > LAYOUT_MAX_BYTES) {
    return { status: 413, body: { error: 'too-large', message: 'the presets of this view would exceed 64 KiB' } };
  }
  dbApi.uiLayoutSet(owner, sharedKey, value);
  if (folded.length) dbApi.uiLayoutDelete(owner, legacyScope);
  audit('widgets.preset.save', saved.preset.id);
  return {
    status: 200,
    body: {
      ok: true,
      replaced: saved.replaced,
      preset: { id: saved.preset.id, name: saved.preset.name, view, project, rows: Object.keys(scopes) },
    },
  };
}

export type WidgetRouteOptions = {
  /** Tests stand in for the plugin loader. */
  plugins?: (req: Request) => PluginPublic[];
};

export function registerWidgetRoutes(app: Router, opts: WidgetRouteOptions = {}): void {
  const pluginsOf = opts.plugins ?? ((req: Request) => galleryPlugins(loaderFromApp(req.app)));

  const revalidate = (payload: unknown, owner: UserRow, req: Request): ProposalProblem[] => {
    const parsed = WidgetsProposal.safeParse(payload);
    if (!parsed.success) return [{ code: 'invalid_payload', message: 'the stored proposal no longer parses' }];
    const key = workspaceKey(owner.id, parsed.data.view, parsed.data.project ?? null);
    return validateWidgetsProposal(parsed.data, {
      snapshot: snapshotOf(owner),
      columns: columnsOf(owner.id, key, parsed.data.view),
      allowed: allowedFor(owner, pluginsOf(req)),
    });
  };
  registerProposalKind(WIDGETS_KIND, { label: 'widget arrangement', revalidate });

  // The owner's browser hands over what only it knows: titles, compact forms, starters, mounted zones.
  app.put('/api/widgets/snapshot', (req, res) => {
    const auth = req.auth;
    if (!auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (!isPersonAuth(auth) || !auth.user) {
      forbidden(req, res, { kind: 'scope', reason: 'the widget catalog is published by a signed-in browser' });
      return;
    }
    if (Buffer.byteLength(JSON.stringify(req.body ?? {})) > SNAPSHOT_MAX_BYTES) {
      res.status(413).json({ error: 'too_large' });
      return;
    }
    const body = SnapshotBody.safeParse(req.body ?? {});
    if (!body.success) { res.status(400).json(apiError('invalid_request', 'invalid_request')); return; }
    const next = mergeSnapshot(snapshotOf(auth.user), body.data, Date.now());
    dbApi.uiLayoutSet(auth.user.id, SNAPSHOT_SCOPE, JSON.stringify(next));
    res.json({ ok: true });
  });

  app.get('/api/widgets', (req, res) => {
    const caller = callerOf(req, res, 'read');
    if (!caller) return;
    send(res, readWidgets(caller, req.query, pluginsOf(req)));
  });

  app.post('/api/widgets/proposals', (req, res) => {
    const auth = req.auth;
    if (!auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    // Only an agent, through its own mission's token: the card lives in that mission's conversation.
    if (auth.kind !== 'api-token' || !auth.missionId) {
      forbidden(req, res, {
        kind: 'scope',
        reason: 'only an agent mission can propose an arrangement',
        hint: 'Arrange the widgets yourself from the Customize interface menu; a proposal is raised by an agent.',
      });
      return;
    }
    const caller = callerOf(req, res, 'write');
    if (!caller?.mission) return;
    send(res, proposeWidgets({ owner: caller.owner, mission: caller.mission }, (req.body ?? {}) as Record<string, unknown>,
      pluginsOf(req), (action, target) => auditRequest(req, action, target)));
  });

  app.post('/api/widgets/presets', (req, res) => {
    const caller = callerOf(req, res, 'write');
    if (!caller) return;
    send(res, saveViewPreset(caller, req.body, (action, target) => auditRequest(req, action, target)));
  });
}
