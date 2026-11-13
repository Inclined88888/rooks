/**
 * `ctx.routines` (API 10): a plugin schedules recurring work — a cron
 * expression, an agent, a prompt — and the daemon opens one Kanban task per
 * tick, exactly like a routine made in the app.
 *
 * The routine belongs to the plugin: owner `plugin:<id>`, in a request as in a
 * job, so the tasks it opens (and their missions) are the plugin's too. A
 * plugin reads what the caller sees plus what it owns, and changes only what it
 * owns; anything else answers like a row that does not exist. The daemon's own
 * routine (nightly backup) is never reachable: it is a system row.
 *
 * A routine opens tasks, so the plugin must also declare `kanban:write`, and in
 * a request the caller must hold it. The rhythm is bounded (no more often than
 * every five minutes) and so is the count: a routine is unattended work that
 * burns a subscription.
 *
 * For the same reason a routine is a deferred spawn of the plugin, whoever
 * asked for it: it ticks as `plugin:<id>` with nobody in front. Each tick takes
 * the approval and the quota of `ctx.missions.spawn` (`tickRoutines`), and
 * creating or re-enabling one is refused up front while the plugin is not
 * approved to spawn (signed, or `pluginPolicy.spawn.approved`, TODO #591) —
 * rather than storing a routine refused at every tick.
 */
import { existsSync } from 'node:fs';
import { CronExpressionParser } from 'cron-parser';
import { canonicalAgentName } from '../agent-config.js';
import { dbApi, isTaskType, type RoutineRow, type TaskType } from '../db.js';
import { agentDir } from '../paths.js';
import { createRoutine, updateRoutine } from '../routines.js';
import {
  ownedByPlugin, PluginAutomationError, pluginOwnerOf, visibleTo, type AutomationCaller,
} from './automation-scope.js';
import { emitAutomationEvent } from './automation-events.js';
import { assertSpawnApproved, PluginPolicyError } from './policy.js';

import type { PluginRoutine, PluginRoutineInput, PluginRoutinePatch } from './contract/automation.js';
export type { PluginRoutine, PluginRoutineInput, PluginRoutinePatch } from './contract/automation.js';

export type ScopedRoutines = {
  list(): PluginRoutine[];
  create(input: PluginRoutineInput): PluginRoutine;
  update(id: string, patch: PluginRoutinePatch): PluginRoutine;
  delete(id: string): boolean;
};

export type RoutineCallerScope = AutomationCaller;

/** Routines one plugin owns at once. */
export const MAX_PLUGIN_ROUTINES = 50;
/** The shortest gap between two ticks of a plugin's routine. */
export const MIN_ROUTINE_INTERVAL_MS = 5 * 60_000;

function checkCron(cron: unknown): string {
  if (typeof cron !== 'string' || !cron.trim() || cron.length > 200) throw new PluginAutomationError('invalid', 'cron: a cron expression');
  try {
    const it = CronExpressionParser.parse(cron);
    let previous = it.next().getTime();
    for (let i = 0; i < 8; i++) {
      const next = it.next().getTime();
      if (next - previous < MIN_ROUTINE_INTERVAL_MS) {
        throw new PluginAutomationError('invalid', `cron: a plugin's routine runs at most every ${MIN_ROUTINE_INTERVAL_MS / 60_000} minutes`);
      }
      previous = next;
    }
  } catch (err) {
    if (err instanceof PluginAutomationError) throw err;
    throw new PluginAutomationError('invalid', `cron: ${(err as Error).message}`);
  }
  return cron;
}

const text = (field: string, value: unknown, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new PluginAutomationError('invalid', `${field}: a non-empty string of at most ${max} characters`);
  }
  return value;
};

/** A routine row as `pluginId` sees it. Also what the lifecycle events carry. */
export function routineView(row: RoutineRow, pluginId: string): PluginRoutine {
  return {
    id: row.id, name: row.name, agent: row.agent_name, prompt: row.prompt, taskType: row.task_type,
    cron: row.cron_expr, enabled: row.enabled === 1, project: row.project,
    lastRunAt: row.last_run_at, nextRunAt: row.enabled === 1 ? row.next_run_at : null, createdAt: row.created_at,
    mine: ownedByPlugin({ pluginId }, row.owner_user_id),
  };
}

export function routinesFor(caller: RoutineCallerScope): ScopedRoutines {
  const view = (row: RoutineRow): PluginRoutine => routineView(row, caller.pluginId);
  const seen = (row: RoutineRow | undefined): RoutineRow | undefined =>
    row && visibleTo(caller, row.owner_user_id) ? row : undefined;
  const origin = { kind: 'plugin', id: caller.pluginId } as const;
  const mineCount = () => dbApi.listRoutines().filter((r) => ownedByPlugin(caller, r.owner_user_id)).length;

  const agentOf = (agent: unknown): string => {
    const name = text('agent', agent, 200);
    if (!existsSync(agentDir(canonicalAgentName(name)))) throw new PluginAutomationError('invalid', `unknown agent: ${name}`);
    return name;
  };
  const projectOf = (project: unknown): string | null => {
    if (project === null || project === undefined || project === '') return null;
    const slug = text('project', project, 200);
    if (!dbApi.getProjectRow(slug)) throw new PluginAutomationError('invalid', `unknown project: ${slug}`);
    return slug;
  };
  const taskTypeOf = (value: unknown): TaskType => {
    if (!isTaskType(value)) throw new PluginAutomationError('invalid', `taskType: one of code, review, merge, research, doc, chore`);
    return value;
  };

  /** An enabled routine will tick as the plugin: the operator must have approved it. */
  const approved = (via: string): void => {
    try {
      assertSpawnApproved(caller.pluginId, via);
    } catch (err) {
      if (err instanceof PluginPolicyError) throw new PluginAutomationError('forbidden', err.message);
      throw err;
    }
  };

  return {
    list() {
      return dbApi.listRoutines().filter((r) => seen(r)).map(view);
    },

    create(input) {
      const fields = (input ?? {}) as Record<string, unknown>;
      const name = text('name', fields.name, 200);
      const agent = agentOf(fields.agent);
      const prompt = text('prompt', fields.prompt, 20_000);
      const cron = checkCron(fields.cron);
      const taskType = fields.taskType === undefined ? 'chore' : taskTypeOf(fields.taskType);
      if (fields.enabled !== undefined && typeof fields.enabled !== 'boolean') {
        throw new PluginAutomationError('invalid', 'enabled: a boolean');
      }
      const project = projectOf(fields.project);
      if (mineCount() >= MAX_PLUGIN_ROUTINES) {
        throw new PluginAutomationError('quota', `a plugin owns at most ${MAX_PLUGIN_ROUTINES} routines`);
      }
      if (fields.enabled !== false) approved('ctx.routines.create');
      let created: RoutineRow;
      try {
        created = createRoutine({
          name, agent_name: agent, prompt, task_type: taskType, cron_expr: cron,
          enabled: fields.enabled as boolean | undefined, project, ownerUserId: pluginOwnerOf(caller.pluginId),
        });
      } catch (err) {
        throw new PluginAutomationError('invalid', (err as Error).message);
      }
      emitAutomationEvent({ kind: 'routine_created', row: created, origin });
      return view(created);
    },

    update(id, patch) {
      const row = seen(typeof id === 'string' ? dbApi.getRoutine(id) : undefined);
      if (!row) throw new PluginAutomationError('not_found', `routine not found: ${String(id)}`);
      if (!ownedByPlugin(caller, row.owner_user_id)) {
        throw new PluginAutomationError('forbidden', `routine ${row.id} was not created by this plugin`);
      }
      const fields = (patch ?? {}) as Record<string, unknown>;
      if (fields.enabled !== undefined && typeof fields.enabled !== 'boolean') {
        throw new PluginAutomationError('invalid', 'enabled: a boolean');
      }
      if (fields.enabled === true && row.enabled !== 1) approved('ctx.routines.update');
      let updated: RoutineRow;
      try {
        updated = updateRoutine(row.id, {
          name: fields.name === undefined ? undefined : text('name', fields.name, 200),
          agent_name: fields.agent === undefined ? undefined : agentOf(fields.agent),
          prompt: fields.prompt === undefined ? undefined : text('prompt', fields.prompt, 20_000),
          task_type: fields.taskType === undefined ? undefined : taskTypeOf(fields.taskType),
          cron_expr: fields.cron === undefined ? undefined : checkCron(fields.cron),
          enabled: fields.enabled as boolean | undefined,
          project: fields.project === undefined ? undefined : projectOf(fields.project),
        });
      } catch (err) {
        if (err instanceof PluginAutomationError) throw err;
        throw new PluginAutomationError('invalid', (err as Error).message);
      }
      emitAutomationEvent({ kind: 'routine_updated', row: updated, origin });
      return view(updated);
    },

    delete(id) {
      const row = seen(typeof id === 'string' ? dbApi.getRoutine(id) : undefined);
      if (!row) return false;
      if (!ownedByPlugin(caller, row.owner_user_id)) {
        throw new PluginAutomationError('forbidden', `routine ${row.id} was not created by this plugin`);
      }
      dbApi.deleteRoutine(row.id);
      emitAutomationEvent({ kind: 'routine_deleted', row, origin });
      return true;
    },
  };
}
