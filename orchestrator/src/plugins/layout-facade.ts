/**
 * `ctx.layout`, `ctx.ui.navigate` and `ctx.onboarding` (API 10): the screen
 * arrangement as a THIRD-PARTY plugin reaches it, with the same guards and the
 * same cards as the `widgets_*`, `islands_*`, `nav_*` and `ui_navigate` MCP tools.
 *
 * Nothing here changes the screen. A proposal becomes a card in a mission's
 * conversation that only the account's own browser can apply; reading and
 * saving a preset concern the account's arrangement, never another's.
 *
 * Whose screen: always the account behind the REQUEST. In a job there is no
 * account (`plugin:<id>` owns nothing on screen): every method throws
 * `no_owner`. A proposal also names a mission, which must be that account's
 * own — seeing a mission (a superadmin sees all) is not owning it.
 *
 * Who raised it: the plugin. Its card shows `plugin:<id>`, its origin is set
 * here from the plugin's identity, never from the arguments, and the answer
 * never goes to the mission's agent (`layout-proposals.ts`). The plugin reads
 * the answer back with `proposals.get` / `proposals.list`, its own cards only.
 *
 * `ui.navigate` always raises a card: the guided-tour grant that lets an
 * agent's navigation open at once belongs to the agent's mission, not to a
 * plugin. A plugin's own browser half keeps `navigate` direct.
 */
import {
  dbApi, type DbViewer, type LayoutProposalRow, type MissionRow, type UserRow,
} from '../db.js';
import { PLUGIN_OWNER_PREFIX } from '../users/api-tokens.js';
import { scopedDb } from '../users/scoped-db.js';
import type { Reply } from '../plugins-bundled/settings/layout-proposals.js';
import type { PluginPublic } from './public.js';
import { currentGallery } from './runtime.js';

import type {
  PluginLayoutErrorCode, PluginPresetInput, PluginLayoutReceipt, PluginLayoutProposal, ScopedLayout,
} from './contract/layout.js';
export type { ScopedLayout } from './contract/layout.js';
export type {
  PluginLayoutErrorCode, PluginLayoutTarget, PluginLayoutSnapshot, PluginLayoutProposalInput,
  PluginWidgetsProposalInput, PluginIslandsProposalInput, PluginNavProposalInput, PluginNavigateInput,
  PluginPresetInput, PluginLayoutReceipt, PluginLayoutProposalKind, PluginLayoutProposal,
} from './contract/layout.js';

export class PluginLayoutError extends Error {
  constructor(
    readonly code: PluginLayoutErrorCode,
    message: string = code,
    /** What the validation found, as the MCP tools return it (`invalid_proposal`, `invalid`). */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PluginLayoutError';
  }
}

export type LayoutCallerScope = {
  pluginId: string;
  viewer: DbViewer | null;
  /** The account of the request; `plugin:<id>` in a job, `null` before any account exists. */
  ownerUserId: string | null;
  /** The loaded plugins, to tell which widgets the owner may see. Tests stand in. */
  plugins?: () => PluginPublic[];
};

/** The account a request acts for: a real, active one — never a job, never another's. */
export function accountOf(scope: Pick<LayoutCallerScope, 'ownerUserId'>): UserRow {
  const id = scope.ownerUserId;
  const user = id && !id.startsWith(PLUGIN_OWNER_PREFIX) ? dbApi.getUserById(id) : undefined;
  if (!user || user.status !== 'active') {
    throw new PluginLayoutError('no_owner', 'the screen belongs to an account: call this from a request of a signed-in user, not from a job');
  }
  return user;
}

/** One of the account's OWN missions. Another's, an absent one and one the viewer cannot see all answer alike. */
export function ownMission(scope: Pick<LayoutCallerScope, 'viewer'>, user: UserRow, missionId: unknown): MissionRow {
  const mission = typeof missionId === 'string' ? scopedDb(scope.viewer).getMission(missionId) : undefined;
  if (!mission || mission.owner_user_id !== user.id) throw new PluginLayoutError('not_found', 'mission not found');
  return mission;
}

type ErrorBody = { error?: string; message?: string; problems?: unknown; issues?: unknown };

/** The success body of a route core, or the typed error of its refusal. */
export function unwrapReply<T>(reply: Reply): T {
  if (reply.status >= 200 && reply.status < 300) return reply.body as T;
  const body = (reply.body ?? {}) as ErrorBody;
  const details = body.problems ?? body.issues;
  const message = body.message ?? body.error ?? 'refused';
  if (reply.status === 413) throw new PluginLayoutError('too_large', message);
  if (body.error === 'invalid_proposal') {
    const noSnapshot = Array.isArray(body.problems) && body.problems.some((p) => (p as { code?: unknown })?.code === 'no_snapshot');
    throw new PluginLayoutError(noSnapshot ? 'no_snapshot' : 'invalid_proposal', message, details);
  }
  if (body.error === 'invalid_request' || body.error === 'empty_proposal') throw new PluginLayoutError('invalid', message, details);
  if (reply.status === 409 && body.error === 'no_owner') throw new PluginLayoutError('no_owner', message);
  if (reply.status === 409) throw new PluginLayoutError('conflict', message);
  throw new PluginLayoutError('refused', message);
}

function receipt(body: { id: string; warnings?: unknown[] }): PluginLayoutReceipt {
  return Object.freeze({ id: body.id, status: 'pending' as const, ...(body.warnings?.length ? { warnings: body.warnings } : {}) });
}

function proposalView(row: LayoutProposalRow): PluginLayoutProposal {
  let payload: unknown = null;
  try { payload = JSON.parse(row.payload) as unknown; } catch { payload = null; }
  return Object.freeze({
    id: row.id,
    kind: row.kind,
    missionId: row.mission_id,
    status: row.status,
    note: row.note,
    payload,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  });
}

/** The audit row of a plugin's gesture: the account it acted for, `plugin:<id>` as the actor. */
export function pluginAudit(pluginId: string, user: UserRow): (action: string, target: string | null) => void {
  return (action, target) => {
    dbApi.insertAuditLog({ userId: user.id, actor: `${PLUGIN_OWNER_PREFIX}${pluginId}`, action, target, ip: null });
  };
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PluginLayoutError('invalid', 'expected an object');
  }
  return input as Record<string, unknown>;
}

export function layoutFor(scope: LayoutCallerScope): ScopedLayout {
  const { pluginId, viewer } = scope;
  const origin = { kind: 'plugin', id: pluginId } as const;
  const plugins = (): PluginPublic[] => (scope.plugins ?? currentGallery)();
  const audit = (user: UserRow) => pluginAudit(pluginId, user);

  /** The account and, for a proposal, its mission: the `Caller` the route cores take. */
  const readCaller = (): { owner: UserRow; mission: null } => ({ owner: accountOf(scope), mission: null });
  const writeCaller = (missionId: unknown): { owner: UserRow; mission: MissionRow } => {
    const owner = accountOf(scope);
    return { owner, mission: ownMission(scope, owner, missionId) };
  };
  /** The input minus `missionId`: the cores validate the rest with their strict schemas. */
  const withoutMission = (input: unknown): Record<string, unknown> => {
    const { missionId: _missionId, ...rest } = record(input);
    return rest;
  };

  /** A read takes `project: ''` for "no project"; a caller that says `null` means the same. */
  const readTarget = (target: unknown): Record<string, unknown> => {
    const t = record(target);
    return t.project === null ? { ...t, project: '' } : t;
  };

  const preset = async (input: PluginPresetInput) => {
    const { saveViewPreset } = await import('../plugins-bundled/settings/widget-routes.js');
    const caller = readCaller();
    const out = unwrapReply<{ preset: { id: string; name: string }; replaced: boolean }>(
      saveViewPreset(caller, record(input), audit(caller.owner)),
    );
    return { id: out.preset.id, name: out.preset.name, replaced: out.replaced };
  };

  return {
    widgets: {
      async get(target = {}) {
        const { readWidgets } = await import('../plugins-bundled/settings/widget-routes.js');
        return Object.freeze(unwrapReply<Record<string, unknown>>(readWidgets(readCaller(), readTarget(target), plugins())));
      },
      async propose(input) {
        const { proposeWidgets } = await import('../plugins-bundled/settings/widget-routes.js');
        const caller = writeCaller(record(input).missionId);
        return receipt(unwrapReply(proposeWidgets(caller, withoutMission(input), plugins(), audit(caller.owner), origin)));
      },
      presetSave: preset,
    },
    islands: {
      async get(target = {}) {
        const { readIslands } = await import('../plugins-bundled/settings/island-routes.js');
        return Object.freeze(unwrapReply<Record<string, unknown>>(readIslands(readCaller(), readTarget(target), plugins())));
      },
      async propose(input) {
        const { proposeIslands } = await import('../plugins-bundled/settings/island-routes.js');
        const caller = writeCaller(record(input).missionId);
        return receipt(unwrapReply(proposeIslands(caller, withoutMission(input), plugins(), audit(caller.owner), origin)));
      },
      // A preset is the view's: the same capture as the widgets', `.islands` included.
      presetSave: preset,
    },
    nav: {
      async get() {
        const { readNav } = await import('../plugins-bundled/settings/nav-routes.js');
        return Object.freeze(unwrapReply<Record<string, unknown>>(readNav(readCaller())));
      },
      async propose(input) {
        const { proposeNav } = await import('../plugins-bundled/settings/nav-routes.js');
        const caller = writeCaller(record(input).missionId);
        return receipt(unwrapReply(proposeNav(caller, withoutMission(input), audit(caller.owner), origin)));
      },
    },
    async navigate(input) {
      const { proposeNavigate } = await import('../plugins-bundled/settings/navigate-routes.js');
      const caller = writeCaller(record(input).missionId);
      // `direct: false`: the guided-tour shortcut is the agent's, never a plugin's.
      return receipt(unwrapReply(proposeNavigate(caller, withoutMission(input), plugins(), audit(caller.owner), false, origin)));
    },
    proposals: {
      async get(id) {
        if (typeof id !== 'string') return undefined;
        const row = dbApi.getLayoutProposal(id.toLowerCase());
        if (!row || row.origin_kind !== 'plugin' || row.origin_id !== pluginId) return undefined;
        if (row.owner_user_id !== scope.ownerUserId || !scopedDb(viewer).getMission(row.mission_id)) return undefined;
        return proposalView(row);
      },
      async list(filter = {}) {
        // Only the account of the request, only this plugin's cards: in a job, none.
        if (!scope.ownerUserId) return [];
        return dbApi.listLayoutProposals({ ownerUserId: scope.ownerUserId, missionId: filter.missionId, status: filter.status, limit: 500 })
          .filter((row) => row.origin_kind === 'plugin' && row.origin_id === pluginId && scopedDb(viewer).getMission(row.mission_id))
          .slice(0, Math.max(1, Math.min(500, Math.floor(filter.limit ?? 100))))
          .map(proposalView);
      },
    },
    async onboardingProfile() {
      const { readOnboardingProfile } = await import('../plugins-bundled/settings/onboarding-profile-routes.js');
      const stored = readOnboardingProfile(accountOf(scope).id);
      return { profile: stored?.profile ?? null, at: stored?.at ?? null };
    },
  };
}
