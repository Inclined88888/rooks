/**
 * A series' fallback plan and per-role LLM choices, shared by the Kanban routes
 * (`/api/series/:id/{fallbacks,roles}`) and the plugin facade
 * (`plugins/series-facade.ts`). Moved out of the routes so both apply one rule;
 * the bodies are the routes' own, with `res.status(..).json(..)` turned into a
 * thrown `SeriesServiceError`.
 */
import { z } from 'zod';
import { applySeriesFallbackRule } from './backend-fallback.js';
import { backendIdForModel, catalogClaimsModel } from './backends/catalog.js';
import { asBackendName } from './backends/index.js';
import {
  FALLBACK_SCOPES, TASK_TYPES, dbApi, isFallbackScope, rowVisible,
  type DbViewer, type SeriesFallbackRow, type SeriesGroupRuleRow,
} from './db.js';
import { GROUP_NAME_CONTROL_CHARS, MAX_GROUP_NAME_CHARS } from './series-plan.js';
import { scopedDb } from './users/scoped-db.js';

/** `invalid` (400) or `not_found` (404). */
export type SeriesErrorCode = 'invalid' | 'not_found';

export class SeriesServiceError extends Error {
  constructor(readonly code: SeriesErrorCode, message: string) {
    super(message);
    this.name = 'SeriesServiceError';
  }
}

/** Series identifier as it travels in a URL: a mission id or `current`. */
export const SeriesParamSchema = z.object({ id: z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/) });

/**
 * Name of a group of volets of the series plan (`tasks.plan_group`), as a rule
 * names it: a short label, never interpreted (no path, no command — it only
 * ever meets `=` in SQL and a flag on a command line the agent prints).
 * Bounded like the planner's form (`MAX_GROUP_NAME_CHARS`).
 */
export const PlanGroupSchema = z.string().trim().min(1).max(MAX_GROUP_NAME_CHARS)
  // The agent prints the name inside a quoted shell command: a newline or a
  // NUL would survive the quoting (same rule as `validateSeriesPlanForm`).
  .refine((v) => !GROUP_NAME_CONTROL_CHARS.test(v), { message: 'plan group must not contain control characters' });

/**
 * A group name as a task or a rule carries it: `null` when absent, the trimmed
 * name when valid. `ok: false` names the defect (empty, too long, not a string).
 */
export function parsePlanGroup(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  const parsed = PlanGroupSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: `plan group must be a non-empty string of at most ${MAX_GROUP_NAME_CHARS} characters, without control characters`,
    };
  }
  return { ok: true, value: parsed.data };
}

/** Body of `PUT /api/series/:id/roles`. At least one of backend/model: an empty
 *  choice is a deletion, which has its own verb. `group` scopes the choice to
 *  one group of volets of the plan; absent = the whole series. */
export const SeriesRoleBodySchema = z.object({
  scope: z.enum(TASK_TYPES),
  backend: z.string().trim().max(64).nullish(),
  model: z.string().trim().max(128).nullish(),
  // `''` is "no group", as on a task: a form that sends every field empty
  // must not be refused for the one it did not fill.
  group: z.preprocess((v) => (v === '' ? null : v), PlanGroupSchema.nullish()),
}).strict().refine((b) => !!b.backend || !!b.model, { message: 'backend or model required' });

/**
 * A rule of a series as the routes, the CLI and the plugin facade list it:
 * `plan_group` is `null` for a series-wide rule, the group's name otherwise.
 * One list, series rules first: a reader that ignores the field sees exactly
 * the list of before.
 */
export type SeriesRuleRow = SeriesFallbackRow & { plan_group: string | null };

function seriesWide(rows: SeriesFallbackRow[]): SeriesRuleRow[] {
  return rows.map((r) => ({ ...r, plan_group: null }));
}
function ofGroups(rows: SeriesGroupRuleRow[]): SeriesRuleRow[] {
  return rows.map((r) => ({ series_id: r.series_id, scope: r.scope, backend: r.backend, model: r.model, updated_at: r.updated_at, plan_group: r.plan_group }));
}

/**
 * `:id` accepts the id of the series, the one of the mission that pilots it, or
 * `current` (resolved from the caller's `X-ROOKS-Mission`). That is what lets an
 * orchestrator set its plan BEFORE creating any task: the series does not exist
 * yet, but its future identity is already known — its own mission.
 */
export function resolveSeriesId(param: string, currentMission: string | undefined): string | null {
  const raw = param === 'current' ? currentMission ?? '' : param;
  if (!raw) return null;
  return dbApi.seriesIdForMission(raw) ?? raw;
}

/**
 * Whether a caller may read or steer a series. A series is its pilot mission
 * plus the tasks it spawned: a non-superadmin must see that mission or own one of
 * those tasks. Otherwise the answer is "not found" — a refusal would confirm the series exists.
 */
export function seriesVisibleTo(viewer: DbViewer | null, seriesId: string): boolean {
  if (!viewer || viewer.isSuperadmin) return !!viewer;
  if (scopedDb(viewer).getMission(seriesId)) return true;
  return dbApi.listTasksBySeries(seriesId).some((t) => rowVisible(t, viewer, 'tasks'));
}

export type FallbackRuleInput = {
  scope?: string;
  backend?: string | null;
  model?: string | null;
  apply?: boolean;
  /** Group of volets the rule governs; absent = the whole series. */
  group?: string | null;
};

export function listSeriesFallbackRules(seriesId: string): SeriesRuleRow[] {
  return [...seriesWide(dbApi.listSeriesFallbacks(seriesId)), ...ofGroups(dbApi.listSeriesGroupFallbacks(seriesId))];
}

/** The group a rule names, or a refusal. The pilot runs the whole series: its
 *  scope has no group. */
function ruleGroup(raw: unknown, scope: string): string | null {
  const group = parsePlanGroup(raw);
  if (!group.ok) throw new SeriesServiceError('invalid', group.error);
  if (group.value && scope === 'orchestrator') {
    throw new SeriesServiceError('invalid', 'scope "orchestrator" has no group: the pilot runs the whole series');
  }
  return group.value;
}

/**
 * Sets a fallback rule — and APPLIES it, unless `apply: false`.
 *
 * Writing the rule without applying it was the useless gesture of the night of
 * 2026-09-01: the target was recorded, yet tasks already blocked restarted on the
 * dead backend anyway (see `applySeriesFallbackRule`). Before a chantier starts the
 * series has no PENDING/BLOCKED task: applying changes nothing there.
 */
export async function setSeriesFallbackRule(seriesId: string, body: FallbackRuleInput): Promise<{
  series_id: string;
  fallbacks: SeriesRuleRow[];
  applied: { backend: string; model: string | null } | null;
  apply_error?: string;
}> {
  if (!isFallbackScope(body.scope)) {
    throw new SeriesServiceError('invalid', `unknown scope "${body.scope}" (expected: ${FALLBACK_SCOPES.join(' | ')})`);
  }
  const group = ruleGroup(body.group, body.scope);
  // `backend: null` is a choice, not an omission: "this scope does not fall back".
  // It differs from no rule at all, which lets the wildcard then the global setting play.
  const backend = body.backend == null || body.backend === '' ? null : asBackendName(body.backend);
  if (body.backend != null && body.backend !== '' && !backend) {
    throw new SeriesServiceError('invalid', `unknown backend "${body.backend}"`);
  }
  const model = body.model?.trim() || null;
  if (model && backend && !catalogClaimsModel(backend, model) && backendIdForModel(model)) {
    throw new SeriesServiceError(
      'invalid',
      `model "${model}" does not belong to backend ${backend} (claimed by ${backendIdForModel(model)})`,
    );
  }
  if (group) dbApi.setSeriesGroupFallback(seriesId, group, body.scope, backend, model);
  else dbApi.setSeriesFallback(seriesId, body.scope, backend, model);
  // A switch that fails must not lose the rule: it is already written, and the
  // error is returned in the clear rather than a 500 suggesting nothing was set.
  let applied: { backend: string; model: string | null } | null = null;
  let applyError: string | null = null;
  if (body.apply !== false) {
    try {
      applied = await applySeriesFallbackRule(seriesId, body.scope, group);
    } catch (err) {
      applyError = (err as Error).message;
    }
  }
  return {
    series_id: seriesId,
    fallbacks: listSeriesFallbackRules(seriesId),
    applied,
    ...(applyError ? { apply_error: applyError } : {}),
  };
}

export function clearSeriesFallbackRule(seriesId: string, scope: string, rawGroup?: unknown): SeriesRuleRow[] {
  const group = ruleGroup(rawGroup, scope);
  if (group) dbApi.clearSeriesGroupFallback(seriesId, group, scope);
  else dbApi.clearSeriesFallback(seriesId, scope);
  return listSeriesFallbackRules(seriesId);
}

/**
 * Backend/model per task type FOR THIS SERIES — the planner's per-role picks.
 *
 * Never written to `roles.json`: that file is the project default, and the
 * planner's choices must die with the series. Read live at dispatch (task
 * override > series role > roles.json > agent config), so nothing is applied
 * to existing tasks here, unlike the fallback rules.
 */
export function listSeriesRoleChoices(seriesId: string): SeriesRuleRow[] {
  return [...seriesWide(dbApi.listSeriesRoles(seriesId)), ...ofGroups(dbApi.listSeriesGroupRoles(seriesId))];
}

export function setSeriesRoleChoice(seriesId: string, raw: unknown): SeriesRuleRow[] {
  const parsed = SeriesRoleBodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new SeriesServiceError('invalid', parsed.error.issues.map((i) => i.message).join('; '));
  }
  const { scope } = parsed.data;
  const backendInput = parsed.data.backend || null;
  const backend = backendInput ? asBackendName(backendInput) : null;
  if (backendInput && !backend) throw new SeriesServiceError('invalid', `unknown backend "${backendInput}"`);
  const model = parsed.data.model || null;
  if (model && backend && !catalogClaimsModel(backend, model) && backendIdForModel(model)) {
    throw new SeriesServiceError(
      'invalid',
      `model "${model}" does not belong to backend ${backend} (claimed by ${backendIdForModel(model)})`,
    );
  }
  const group = parsed.data.group || null;
  if (group) dbApi.setSeriesGroupRole(seriesId, group, scope, backend, model);
  else dbApi.setSeriesRole(seriesId, scope, backend, model);
  return listSeriesRoleChoices(seriesId);
}

export function clearSeriesRoleChoice(seriesId: string, rawScope: string, rawGroup?: unknown): SeriesRuleRow[] {
  const scope = z.enum(TASK_TYPES).safeParse(rawScope);
  if (!scope.success) {
    throw new SeriesServiceError('invalid', `unknown scope "${rawScope}" (expected: ${TASK_TYPES.join(' | ')})`);
  }
  const group = parsePlanGroup(rawGroup);
  if (!group.ok) throw new SeriesServiceError('invalid', group.error);
  if (group.value) dbApi.clearSeriesGroupRole(seriesId, group.value, scope.data);
  else dbApi.clearSeriesRole(seriesId, scope.data);
  return listSeriesRoleChoices(seriesId);
}

/**
 * The LLM choice a task of this series resolves on: its group's row field by
 * field over the series-wide one (a group that names only a backend keeps the
 * series' model). `undefined` when neither exists. Shared by the dispatcher and
 * the board, so a badge never shows a pair the spawn would not use.
 */
export function seriesLlmChoice(
  seriesId: string | null,
  type: string,
  planGroup: string | null | undefined,
): { backend: string | null; model: string | null } | undefined {
  if (!seriesId) return undefined;
  const group = planGroup ? dbApi.getSeriesGroupRole(seriesId, planGroup, type) : undefined;
  const series = dbApi.getSeriesRole(seriesId, type);
  if (!group && !series) return undefined;
  return { backend: group?.backend ?? series?.backend ?? null, model: group?.model ?? series?.model ?? null };
}
