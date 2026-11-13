/**
 * `ctx.series` (API 10): the fallback plan of a task series and the
 * backend/model chosen per task type for it.
 *
 * A series is its pilot mission plus the tasks it spawned (`series-service.ts`).
 * It is bounded by the caller exactly as the `/roles` routes bound it: in a
 * request, a series whose pilot mission or one of whose tasks that account can
 * see; in a job, one whose pilot mission or tasks `plugin:<id>` owns. Any other
 * series answers `not_found`, as one that does not exist. `current` is refused:
 * a plugin has no mission to resolve it from, it names the series (or its pilot
 * mission) it means.
 *
 * Writes go through `series-service.ts`, the code behind
 * `PUT /api/series/:id/{fallbacks,roles}`. On top of it, a caller who is not a
 * superadmin cannot name a backend or model that a non-superadmin's agent could
 * not run (`agentConfigRefusal`), jobs included.
 */
import { FALLBACK_SCOPES, isFallbackScope, type DbViewer } from '../db.js';
import {
  clearSeriesFallbackRule, clearSeriesRoleChoice, listSeriesFallbackRules, listSeriesRoleChoices, resolveSeriesId,
  SeriesParamSchema, SeriesServiceError, seriesVisibleTo, setSeriesFallbackRule, setSeriesRoleChoice, type SeriesRuleRow,
} from '../series-service.js';
import { agentConfigRefusal, RESTRICTED } from '../users/privileged-overrides.js';

import type {
  PluginSeriesRule, PluginSeriesFallbackInput, PluginSeriesFallbackResult, PluginSeriesRoleInput,
  PluginSeriesErrorCode,
} from './contract/series.js';
export type {
  PluginSeriesRule, PluginSeriesFallbackInput, PluginSeriesFallbackResult, PluginSeriesRoleInput,
  PluginSeriesErrorCode,
} from './contract/series.js';

export class PluginSeriesError extends Error {
  constructor(readonly code: PluginSeriesErrorCode, message: string) {
    super(message);
    this.name = 'PluginSeriesError';
  }
}

export type SeriesCallerScope = { pluginId: string; viewer: DbViewer | null };

export type ScopedSeries = {
  fallback: {
    list(seriesId: string): PluginSeriesRule[];
    set(seriesId: string, rule: PluginSeriesFallbackInput): Promise<PluginSeriesFallbackResult>;
    /** `group`: the rule of that group of volets; absent = the series-wide one. */
    clear(seriesId: string, scope: string, group?: string | null): PluginSeriesRule[];
  };
  role: {
    list(seriesId: string): PluginSeriesRule[];
    set(seriesId: string, choice: PluginSeriesRoleInput): PluginSeriesRule[];
    clear(seriesId: string, scope: string, group?: string | null): PluginSeriesRule[];
  };
};

const view = (row: SeriesRuleRow): PluginSeriesRule => ({
  scope: row.scope, backend: row.backend, model: row.model, updatedAt: row.updated_at, planGroup: row.plan_group,
});

export function seriesFor(scope: SeriesCallerScope): ScopedSeries {
  const { viewer } = scope;

  /** The series a caller names, if it can see it. */
  const resolve = (id: unknown): string => {
    if (typeof id !== 'string' || id === 'current' || !SeriesParamSchema.safeParse({ id }).success) {
      throw new PluginSeriesError('invalid', 'series: a series id or the id of its pilot mission is required');
    }
    const seriesId = resolveSeriesId(id, undefined);
    if (!seriesId || !seriesVisibleTo(viewer, seriesId)) throw new PluginSeriesError('not_found', `series not found: ${id}`);
    return seriesId;
  };

  const guard = <T>(fn: () => T): T => {
    try { return fn(); } catch (err) {
      if (err instanceof SeriesServiceError) throw new PluginSeriesError(err.code, err.message);
      throw err;
    }
  };

  /** A target the caller could not give an agent of its own is not given to a series. */
  const target = (backend: string | null | undefined, model: string | null | undefined): void => {
    if (viewer?.isSuperadmin) return;
    const llm: Record<string, unknown> = {};
    if (backend) llm.backend = backend;
    if (model) llm.model = model;
    const refusal = agentConfigRefusal(llm, null, RESTRICTED);
    if (refusal) throw new PluginSeriesError('forbidden', refusal);
  };

  return {
    fallback: {
      list: (seriesId) => listSeriesFallbackRules(resolve(seriesId)).map(view),
      async set(seriesId, rule) {
        const id = resolve(seriesId);
        if (!rule || typeof rule !== 'object') throw new PluginSeriesError('invalid', 'fallback rule must be an object');
        target(rule.backend, rule.model);
        const out = await (async () => {
          try {
            return await setSeriesFallbackRule(id, rule);
          } catch (err) {
            if (err instanceof SeriesServiceError) throw new PluginSeriesError(err.code, err.message);
            throw err;
          }
        })();
        return { rules: out.fallbacks.map(view), applied: out.applied, applyError: out.apply_error ?? null };
      },
      clear: (seriesId, scopeName, group) => {
        const id = resolve(seriesId);
        if (!isFallbackScope(scopeName)) {
          throw new PluginSeriesError('invalid', `unknown scope "${String(scopeName)}" (expected: ${FALLBACK_SCOPES.join(' | ')})`);
        }
        return guard(() => clearSeriesFallbackRule(id, scopeName, group).map(view));
      },
    },
    role: {
      list: (seriesId) => listSeriesRoleChoices(resolve(seriesId)).map(view),
      set(seriesId, choice) {
        const id = resolve(seriesId);
        if (!choice || typeof choice !== 'object') throw new PluginSeriesError('invalid', 'role choice must be an object');
        target(choice.backend, choice.model);
        return guard(() => setSeriesRoleChoice(id, choice).map(view));
      },
      clear: (seriesId, scopeName, group) => guard(() => clearSeriesRoleChoice(resolve(seriesId), String(scopeName), group).map(view)),
    },
  };
}
