/**
 * `ctx.triggers`: a plugin retires the hand-made triggers it supersedes, and
 * wires triggers of its own.
 *
 * Two doors, kept apart on purpose:
 *  - `triggers:disable` (API 6): `list` and `disable`, nothing else. Re-enabling
 *    stays a human gesture in the triggers page;
 *  - `triggers:read` / `triggers:write` / `triggers:execute` (API 10): `get`,
 *    `create`, `remove`, `test`. A plugin changes only the triggers it owns.
 *
 * A trigger a plugin creates belongs to it: its owner is `plugin:<id>`, in a
 * request as in a job. Consequences, deliberate:
 *  - an `event` trigger fires on the rows of its owner only, so it reacts to
 *    what `plugin:<id>` owns — never to another account's tasks or missions.
 *    To react to a user's events, the plugin listens with `ctx.events.on`;
 *  - the tasks, ideas and notifications its actions make are owned by the
 *    plugin too, as a job's are;
 *  - the page of triggers lists it to a superadmin only.
 *
 * What a trigger may DO is capped by the manifest: its frozen grants are the
 * action permissions the plugin declares (`kanban:write`, `notify`,
 * `workflows:run`, `http:outbound`), intersected with the caller's own rights
 * in a request, never `*`. A `webhook` action is also held to
 * `pluginPolicy.http`, at creation and at every run — it is no way around
 * `ctx.fetch`. A webhook trigger cannot be unauthenticated. A `task` action
 * is a spawn of the plugin: an enabled trigger carrying one is refused until
 * the plugin is approved to spawn (signed, or `pluginPolicy.spawn.approved`),
 * and every task it opens takes the spawn quota (TODO #591).
 *
 * What a trigger exposes is what identifies it. Of a trigger the plugin does
 * not own: no action body, no secret, and a webhook action shows only its host
 * (a URL may carry a token in its path). Of its own: its definition. A secret
 * is returned once, by `create`, and never read back.
 *
 * Visibility is that of the triggers routes: a superadmin sees every trigger,
 * a user his own, a job those of `plugin:<id>`. A trigger the caller cannot see
 * answers exactly like one that does not exist.
 */
import { existsSync } from 'node:fs';
import { canonicalAgentName } from '../agent-config.js';
import { agentDir } from '../paths.js';
import { actionProvider, grantsAllow, ACTION_UNAVAILABLE } from '../triggers/actions.js';
import { nextScheduleAt } from '../triggers/engine.js';
import { webhookUrlRefusal } from '../triggers/outbound.js';
import {
  ACTION_PERMISSION, providedSecretSchema, scheduleCadenceProblem, testTriggerSchema, triggerDefinitionSchema,
  type TriggerAction,
} from '../triggers/schema.js';
import { generateSecret } from '../triggers/signature.js';
import { runTriggerTest, type TriggerTestResult } from '../triggers/test-run.js';
import {
  deleteTrigger, disableTriggerRow, getTriggerRow, insertTrigger, listTriggerRows, parseTrigger,
  setTriggerOutboundSecret, type Trigger, type TriggerRow,
} from '../triggers/store.js';
import type { DbViewer } from '../db.js';
import { assertFetchAllowed, assertSpawnApproved, PluginPolicyError } from './policy.js';
import {
  ownedByPlugin, PluginAutomationError, pluginOwnerOf, type AutomationCaller,
} from './automation-scope.js';
import { emitAutomationEvent } from './automation-events.js';
import { pluginCallerAllows } from './als.js';

import type {
  PluginTriggerInfo, PluginOwnTrigger, PluginTriggerInput, PluginTriggerCreated,
  PluginTriggerTestOptions,
} from './contract/automation.js';
export type {
  PluginTriggerInfo, PluginOwnTrigger, PluginTriggerInput, PluginTriggerCreated,
  PluginTriggerTestOptions,
} from './contract/automation.js';

export type { PluginTriggerTestResult } from './contract/automation.js';

/** `viewer` and the fields after it are optional for the API 6 door, which needs only the viewer. */
export type TriggerCallerScope = {
  viewer: DbViewer | null;
  pluginId?: string;
  job?: boolean;
  superadmin?: boolean;
  declared?: readonly string[];
};

export type ScopedTriggers = {
  list(): PluginTriggerInfo[];
  get(id: string): PluginTriggerInfo | PluginOwnTrigger | undefined;
  create(input: PluginTriggerInput): PluginTriggerCreated;
  remove(id: string): boolean;
  /** `execute` is refused here unless `mayExecute`: the facade gates it by permission. */
  test(id: string, options: PluginTriggerTestOptions | undefined, mayExecute: boolean): TriggerTestResult;
  /** `true` when the trigger was enabled and is now off. */
  disable(id: string): boolean;
};

/** Triggers one plugin may own at once: they run unattended, so the count is bounded. */
export const MAX_PLUGIN_TRIGGERS = 100;

const ACTION_PERMISSIONS = [...new Set(Object.values(ACTION_PERMISSION))];

function hostOf(url: string): string | null {
  try { return new URL(url).host; } catch { return null; }
}

function safeJson(text: string | null): unknown {
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function infoOf(t: Trigger, mine: boolean): PluginTriggerInfo {
  const hosts = t.actions.flatMap((a) => {
    const host = a.type === 'webhook' ? hostOf(a.url) : null;
    return host ? [host] : [];
  });
  return {
    id: t.id, name: t.name, source: t.source, enabled: t.enabled,
    slug: t.source === 'webhook' ? t.slug : null,
    event: t.source === 'event' ? t.config.event : null,
    actionHosts: [...new Set(hosts)],
    mine,
  };
}

function ownOf(t: Trigger): PluginOwnTrigger {
  return {
    ...infoOf(t, true),
    mine: true,
    config: t.config as Record<string, unknown>,
    filter: t.filter,
    actions: t.actions,
    grants: t.grants ?? [],
    url: t.source === 'webhook' ? `/api/triggers/hooks/${t.slug}` : null,
    lastRunAt: t.lastRunAt,
    nextRunAt: t.nextRunAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/** A trigger row as `pluginId` sees it (`null` when unreadable). Also what the lifecycle events carry. */
export function triggerView(row: TriggerRow, pluginId: string): PluginTriggerInfo | PluginOwnTrigger | null {
  const t = parseTrigger(row);
  if (!t) return null;
  return row.created_by !== 'routine' && ownedByPlugin({ pluginId }, row.owner_user_id) ? ownOf(t) : infoOf(t, false);
}

/** The API 6 rule, unchanged: no viewer sees everything, a superadmin too, a user his own. */
function legacyVisible(owner: string | null, viewer: DbViewer | null): boolean {
  if (!viewer || viewer.isSuperadmin) return true;
  return owner !== null && owner === viewer.id;
}

export function triggersFor(scope: TriggerCallerScope): ScopedTriggers {
  const { viewer } = scope;
  const pluginId = scope.pluginId ?? '';
  const caller: AutomationCaller = {
    pluginId, viewer, job: scope.job ?? false, superadmin: scope.superadmin ?? false, declared: scope.declared ?? [],
  };
  // A routine is stored as a trigger row (`created_by = 'routine'`): it is never
  // a trigger of the plugin, whoever owns it — `ctx.routines` is its door.
  const mineRow = (row: TriggerRow) =>
    pluginId !== '' && row.created_by !== 'routine' && ownedByPlugin(caller, row.owner_user_id);
  // What the triggers routes show the caller, plus what this plugin owns.
  const seen = (row: TriggerRow) => legacyVisible(row.owner_user_id, viewer) || mineRow(row);
  const rows = () => listTriggerRows().filter(seen);
  const findSeen = (id: unknown): TriggerRow | undefined => {
    const row = typeof id === 'string' ? getTriggerRow(id) : undefined;
    return row && seen(row) ? row : undefined;
  };

  const origin = { kind: 'plugin', id: pluginId } as const;

  /** What the plugin declares, and — in a request — what the caller holds as well. */
  const grantsFor = (): string[] => ACTION_PERMISSIONS.filter((permission) =>
    caller.declared.includes(permission) && (caller.job || pluginCallerAllows(viewer, permission)));

  const checkAction = (action: TriggerAction, grants: readonly string[]): void => {
    // Code run on the host is the user's call, never a plugin's.
    if (action.type === 'script') throw new PluginAutomationError('forbidden', 'a plugin cannot create a script action');
    const needed = ACTION_PERMISSION[action.type];
    if (!grantsAllow(grants, needed)) {
      throw new PluginAutomationError('forbidden', `a ${action.type} action needs \`${needed}\`, declared by the plugin${caller.job ? '' : ' and held by the caller'}`);
    }
    if (action.type === 'task' && !existsSync(agentDir(canonicalAgentName(action.agent)))) {
      throw new PluginAutomationError('invalid', `unknown agent: ${action.agent}`);
    }
    if (action.type === 'webhook') {
      try { assertFetchAllowed(pluginId, action.url); } catch (err) {
        if (err instanceof PluginPolicyError) throw new PluginAutomationError('forbidden', err.message);
        throw err;
      }
      const refused = webhookUrlRefusal(action.url);
      if (refused) throw new PluginAutomationError('invalid', refused);
    }
    if (action.type === 'workflow') {
      const provider = actionProvider('workflow');
      if (!provider) throw new PluginAutomationError('unavailable', ACTION_UNAVAILABLE);
      const denied = provider.check(action, { ownerUserId: pluginOwnerOf(pluginId), seesAll: false });
      if (denied) throw new PluginAutomationError('invalid', denied);
    }
  };

  return {
    list() {
      return rows().flatMap((row) => {
        const t = parseTrigger(row);
        return t ? [infoOf(t, mineRow(row))] : [];
      });
    },

    get(id) {
      const row = findSeen(id);
      return row ? triggerView(row, pluginId) ?? undefined : undefined;
    },

    create(input) {
      if (!pluginId) throw new PluginAutomationError('unavailable', 'trigger host has no plugin identity');
      const { secret: rawSecret, ...rest } = (input ?? {}) as Record<string, unknown>;
      const parsed = triggerDefinitionSchema.safeParse(rest);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new PluginAutomationError('invalid', `${issue?.path.join('.') || 'input'}: ${issue?.message ?? 'invalid'}`);
      }
      const def = parsed.data;
      if (def.source === 'schedule') {
        const tooOften = scheduleCadenceProblem(def.config.cron, def.config.tz);
        if (tooOften) throw new PluginAutomationError('invalid', tooOften);
      }
      let secret: string | null = null;
      if (rawSecret !== undefined) {
        const provided = providedSecretSchema.safeParse(rawSecret);
        if (def.source !== 'webhook' || !provided.success) {
          throw new PluginAutomationError('invalid', 'secret: a string of 16 to 256 characters, for a webhook trigger only');
        }
        secret = provided.data;
      }
      // No secret = no proof of origin: never something a plugin decides.
      if (def.source === 'webhook' && def.config.auth === 'none') {
        throw new PluginAutomationError('forbidden', 'a plugin cannot create an unauthenticated webhook');
      }
      const grants = grantsFor();
      for (const action of def.actions) checkAction(action, grants);
      // Its task actions run missions as the plugin at every fire, with nobody in
      // front: the operator approves the plugin first (TODO #591). Each fire
      // then takes the spawn quota (`runActions`).
      if (def.enabled !== false && def.actions.some((a) => a.type === 'task')) {
        try { assertSpawnApproved(pluginId, 'ctx.triggers.create'); } catch (err) {
          if (err instanceof PluginPolicyError) throw new PluginAutomationError('forbidden', err.message);
          throw err;
        }
      }
      if (listTriggerRows().filter(mineRow).length >= MAX_PLUGIN_TRIGGERS) {
        throw new PluginAutomationError('quota', `a plugin owns at most ${MAX_PLUGIN_TRIGGERS} triggers`);
      }
      if (def.source === 'webhook' && listTriggerRows({ source: 'webhook' }).some((r) => r.slug === def.slug)) {
        throw new PluginAutomationError('conflict', `slug already used: ${def.slug}`);
      }
      if (def.source === 'webhook' && secret === null) secret = generateSecret(def.config.auth);
      let row: TriggerRow;
      try {
        row = insertTrigger({
          name: def.name,
          slug: def.source === 'webhook' ? def.slug : null,
          source: def.source,
          enabled: def.enabled !== false,
          config: def.config,
          filter: def.source === 'schedule' ? null : def.filter ?? null,
          actions: def.actions,
          secret,
          ownerUserId: pluginOwnerOf(pluginId),
          createdBy: 'user',
          creatorAgent: null,
          actingAgent: null,
          grants,
          nextRunAt: def.source === 'schedule' && def.enabled !== false ? nextScheduleAt(def.config, Date.now()) : null,
        });
      } catch (err) {
        throw new PluginAutomationError('invalid', (err as Error).message);
      }
      const outboundSecret = def.actions.some((a) => a.type === 'webhook') ? generateSecret('standard') : null;
      if (outboundSecret) {
        setTriggerOutboundSecret(row.id, outboundSecret);
        row = getTriggerRow(row.id) ?? row;
      }
      const trigger = parseTrigger(row);
      if (!trigger) throw new PluginAutomationError('invalid', 'stored trigger is unreadable');
      emitAutomationEvent({ kind: 'trigger_created', row, origin });
      return {
        trigger: ownOf(trigger),
        ...(secret ? { secret } : {}),
        ...(outboundSecret ? { outboundSecret } : {}),
      };
    },

    remove(id) {
      const row = findSeen(id);
      if (!row) return false;
      // A trigger the plugin can see but does not own — or a routine's row —
      // is not its to delete.
      if (!mineRow(row)) throw new PluginAutomationError('forbidden', `trigger ${row.id} was not created by this plugin`);
      deleteTrigger(row.id);
      emitAutomationEvent({ kind: 'trigger_removed', row, origin });
      return true;
    },

    test(id, options, mayExecute) {
      const row = findSeen(id);
      if (!row) throw new PluginAutomationError('not_found', `trigger not found: ${String(id)}`);
      if (!mineRow(row)) throw new PluginAutomationError('forbidden', `trigger ${row.id} was not created by this plugin`);
      const trigger = parseTrigger(row);
      if (!trigger) throw new PluginAutomationError('invalid', 'stored trigger is unreadable');
      const body = testTriggerSchema.safeParse(options ?? {});
      if (!body.success) {
        throw new PluginAutomationError('invalid', `${body.error.issues[0]?.path.join('.') || 'input'}: ${body.error.issues[0]?.message ?? 'invalid'}`);
      }
      const done = runTriggerTest(trigger, body.data, () => {
        if (!mayExecute) return { status: 403, error: 'executing a trigger needs `triggers:execute`' };
        // What the actions do, the caller must be allowed to do, right now.
        const missing = trigger.actions.find((a) => !caller.job && !pluginCallerAllows(viewer, ACTION_PERMISSION[a.type]));
        return missing ? { status: 403, error: `not permitted: ${missing.type} needs ${ACTION_PERMISSION[missing.type]}` } : null;
      });
      if ('refused' in done) {
        throw new PluginAutomationError(done.refused.status === 413 ? 'invalid' : 'forbidden', done.refused.error);
      }
      return done.result;
    },

    disable(id) {
      const row = rows().find((r) => r.id === id);
      if (!row || !disableTriggerRow(row.id)) return false;
      const after = getTriggerRow(row.id);
      if (after && after.created_by !== 'routine') emitAutomationEvent({ kind: 'trigger_updated', row: after, origin });
      return true;
    },
  };
}
