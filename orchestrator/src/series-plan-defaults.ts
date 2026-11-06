/**
 * What would apply WITHOUT changing anything, resolved for the series planner.
 *
 * WHY ON THE SERVER SIDE. The form offered "inherits the project role" and
 * "TIMON global fallback" as option labels — accurate, but unusable:
 * nobody remembers the fallback set last week, so the choice was
 * made blind, and "keep" meant nothing concrete. These
 * values are known neither to the agent (they live in the database and in the
 * role files) nor to the UI (which only has the catalogue). Only the orchestrator
 * can resolve them, and it does so when opening the form.
 *
 * These are DISPLAY labels, not values to reapply: touching nothing
 * in the form must stay a no-op, not a rewrite of the
 * config with what was just displayed.
 */

import { dbApi } from './db.js';
import { loadConfig, listAgents } from './agent.js';
import { readRoles, type TaskRole } from './projects.js';
import { fallbackFor } from './backend-fallback.js';
import { agentHoldingRole } from './agent-seed.js';
import { implicitBackendName } from './backends/index.js';
import { catalogBackend } from './backends/catalog.js';
import {
  SERIES_PLAN_ROLES,
  fallbackScopeForRole,
  type SeriesPlanRole,
} from './series-plan.js';

/** "What applies today" labels, per role. Fields absent when
 *  nothing can be resolved — the UI then falls back on its generic label. */
export type SeriesPlanDefaults = Partial<
  Record<SeriesPlanRole, { model?: string; fallback?: string }>
>;

function pair(backend: string | null | undefined, model: string | null | undefined): string | undefined {
  if (!backend) return undefined;
  const slug = (model ?? '').trim() || catalogBackend(backend)?.defaultModel || '';
  return slug ? `${backend} / ${slug}` : backend;
}

const AGENT_ROLE_BY_TASK_ROLE: Partial<Record<SeriesPlanRole, string>> = {
  code: 'coder',
  review: 'reviewer',
  merge: 'merger',
  doc: 'librarian',
};

/**
 * Config of the agent that WILL RUN this role (`roles.json` pinning, otherwise the agent of the
 * project that holds the role, otherwise the librarian for `doc`), not that of
 * the orchestrator opening the form.
 *
 * WHY. The "in force" label fell back on the `cfg.model` of the
 * ORCHESTRATOR: the form announced "claude / claude-sonnet-5-5" for
 * code, review and merge while the dispatcher launches timon.coder (opus) and
 * timon.reviewer (codex / gpt-5.6-sol). The user was therefore choosing from a
 * wrong default (series of 30/09/2026: every role set on Sonnet).
 */
function roleAgentConfig(
  role: SeriesPlanRole,
  project: string | null,
  pinned: string | undefined,
): ReturnType<typeof loadConfig> | null {
  const agentRole = AGENT_ROLE_BY_TASK_ROLE[role];
  if (!agentRole) return null;
  try {
    const name = pinned?.trim()
      || (project ? agentHoldingRole(project, agentRole) : null)
      || listAgents().find((a) => (a.role ?? '').toLowerCase() === agentRole)?.name;
    return name ? loadConfig(name) : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the defaults for the mission opening the form.
 *
 * `seriesId` is the id of that mission: it is the series its future tasks
 * will carry, hence the scope that `timon series fallback set` without
 * `--series` will target. Showing the fallback of ANOTHER scope would mislead.
 */
export function seriesPlanDefaults(missionId: string, agentName: string): SeriesPlanDefaults {
  const cfg = (() => {
    try {
      return loadConfig(agentName);
    } catch {
      return {} as ReturnType<typeof loadConfig>;
    }
  })();
  const mission = dbApi.getMission(missionId);
  const missionBackend = mission?.backend_override ?? cfg.backend ?? implicitBackendName();
  const missionModel = mission?.model_override ?? cfg.model ?? null;
  const project = cfg.project ?? null;
  const roles = project ? readRoles(project) : {};

  const out: SeriesPlanDefaults = {};
  for (const role of SERIES_PLAN_ROLES) {
    // STARTING backend/model of the role: it determines the fallback, a
    // fallback always being relative to the backend being left.
    // A choice already made for this series (form reopened) is what applies:
    // same precedence as the dispatcher, series role before project role.
    const seriesRole = role === 'orchestrator' || role === 'mission'
      ? undefined
      : dbApi.getSeriesRole(missionId, role);
    const roleCfg = role === 'orchestrator' || role === 'mission'
      ? null
      : roleAgentConfig(role, project, roles[role as TaskRole]?.agent) ?? cfg;
    const spec = role === 'orchestrator' || role === 'mission'
      ? { backend: missionBackend, model: missionModel }
      : {
          backend: seriesRole?.backend ?? roles[role as TaskRole]?.backend ?? roleCfg?.backend ?? implicitBackendName(),
          model: seriesRole?.model ?? roles[role as TaskRole]?.model ?? roleCfg?.model ?? null,
        };
    const entry: { model?: string; fallback?: string } = {};
    const model = pair(spec.backend, spec.model);
    if (model) entry.model = model;
    const target = fallbackFor(spec.backend, {
      seriesId: missionId,
      scope: fallbackScopeForRole(role),
      fromModel: spec.model,
    });
    const fallback = target ? pair(target.backend, target.model) : undefined;
    if (fallback) entry.fallback = fallback;
    if (Object.keys(entry).length > 0) out[role] = entry;
  }
  return out;
}
