/**
 * `ctx.missions` control and `ctx.traces` (API 10): what a plugin may do to a
 * mission once it exists — redirect it, stop it, summarise it, fork it, search
 * the history — as the CALLER sees it.
 *
 * Bounded like `ctx.missions.list`: in a request, the missions of that account;
 * in a job, the missions owned by `plugin:<id>`. A mission outside that view
 * answers `not_found`, never `forbidden`: existence is not disclosed. The
 * anonymous first-run caller (no viewer) reads, but never acts.
 *
 * Three permissions split the power: `missions:control` acts (send, kill, fork,
 * stop), `missions:transcript` reads what was said (search, summaries, span
 * payloads), `missions:read` stays the light view. Whatever burns the machine's
 * AI subscription (send, fork, summarize) also goes through the operator's
 * `pluginPolicy.spawn` approval and quota, exactly like a spawn.
 *
 * The heavy daemon modules (`agent.js`, `summary.js`, `scope-stop.js`) are
 * imported on demand, like `daemonHost()`: loading a plugin must not pull the
 * dispatcher's import graph.
 */
import { dbApi, type DbViewer } from '../db.js';
import { loadConfig } from '../agent-config.js';
import { PLUGIN_OWNER_PREFIX } from '../users/api-tokens.js';
import {
  PRIVILEGED_CONFIG_PERMISSION, RESTRICTED, spawnOverrideRefusal, type OverrideAuthority,
} from '../users/privileged-overrides.js';
import { scopedDb } from '../users/scoped-db.js';
import { buildTraceView } from '../trace-view.js';
import { parseTimeBound } from '../mission-search.js';
import { pluginCallerAllows } from './als.js';
import { assertSpawnAllowed } from './policy.js';

import type {
  PluginMissionErrorCode, PluginMissionSendResult, PluginMissionSummary, PluginMissionForkInput,
  PluginMissionFork, PluginMissionSearchFilter, PluginMissionSearchResult, PluginStopScope,
  PluginStopReport, PluginTraceOptions, PluginMissionSpawnOverrides,
} from './contract/missions.js';
export type {
  PluginMissionErrorCode, PluginMissionSendResult, PluginMissionSummary, PluginMissionForkInput,
  PluginMissionFork, PluginMissionSearchFilter, PluginMissionSearchResult, PluginStopScope,
  PluginStopReport, PluginTraceOptions, PluginMissionSpawnOverrides,
} from './contract/missions.js';

export class PluginMissionError extends Error {
  constructor(readonly code: PluginMissionErrorCode, message: string = code) {
    super(message);
    this.name = 'PluginMissionError';
  }
}

/** Longest follow-up a plugin may send in one call (same ceiling as `/steer`). */
export const PLUGIN_SEND_MAX_CHARS = 20_000;
const SEARCH_QUERY_MAX_CHARS = 500;

export type ScopedMissionControl = {
  send(missionId: string, text: string): Promise<PluginMissionSendResult>;
  kill(missionId: string): Promise<{ outcome: 'killed' | 'closed' }>;
  summarize(missionId: string, opts?: { force?: boolean }): Promise<PluginMissionSummary>;
  fork(missionId: string, input: PluginMissionForkInput): Promise<PluginMissionFork>;
  search(q: string, filter?: PluginMissionSearchFilter): Promise<PluginMissionSearchResult>;
  stopScope(scope: PluginStopScope): Promise<PluginStopReport>;
  /** Renames a mission as a human would (`manual`, never overwritten); `null` clears it. */
  rename(missionId: string, title: string | null): Promise<{ title: string | null }>;
  traces: { get(id: string, opts?: PluginTraceOptions): Promise<unknown | undefined> };
};

/** Longest title a plugin may set — the same bound as the HTTP rename. */
export const PLUGIN_TITLE_MAX_CHARS = 200;

export type MissionControlCallerScope = {
  pluginId: string;
  viewer: DbViewer | null;
  /** The manifest declares `missions:transcript`. */
  transcript: boolean;
};

/**
 * Same rule as the HTTP spawn (`spawnOverrideRefusal`), applied to a plugin
 * caller. A job, an anonymous caller or an account without
 * `agents:privileged-config` is RESTRICTED: it may only restate what the target
 * agent already declares (a model of the catalogue, a backend that arbitrates
 * tool uses per call). A privileged account may widen, up to its own level.
 */
export function assertSpawnOverrides(agent: string, o: PluginMissionSpawnOverrides, viewer: DbViewer | null): void {
  if (o.model === undefined && o.backend === undefined && !o.extraSkills && !o.extraMcp && !o.allow) return;
  for (const [key, value] of Object.entries({ model: o.model, backend: o.backend })) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) throw new PluginMissionError('invalid', `\`${key}\` must be a non-empty string`);
  }
  for (const [key, value] of Object.entries({ extraSkills: o.extraSkills, extraMcp: o.extraMcp, allow: o.allow })) {
    if (value !== undefined && (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim()))) {
      throw new PluginMissionError('invalid', `\`${key}\` must be an array of non-empty strings`);
    }
  }
  const privileged = viewer !== null && !viewer.id.startsWith(PLUGIN_OWNER_PREFIX)
    && (viewer.isSuperadmin || pluginCallerAllows(viewer, PRIVILEGED_CONFIG_PERMISSION));
  const authority: OverrideAuthority = viewer?.isSuperadmin
    ? { relaxed: true, ceiling: null }
    : privileged ? { relaxed: true, ceiling: null, accountUser: viewer?.id ?? null } : RESTRICTED;
  let config = null;
  try { config = loadConfig(agent); } catch { /* unknown agent: the spawn itself refuses it */ }
  const refusal = spawnOverrideRefusal({
    backend_override: o.backend,
    model_override: o.model,
    extra_mcp_servers: o.extraMcp,
    extra_allowed_tools: o.allow,
  }, config, authority);
  if (refusal) throw new PluginMissionError('override_denied', refusal);
}

function asPositiveLimit(raw: number | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  if (!Number.isFinite(raw) || raw < 1) throw new PluginMissionError('invalid', '`limit` must be a positive number');
  return Math.min(Math.floor(raw), max);
}

function timeBound(raw: string | number | undefined, key: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = parseTimeBound(String(raw));
  if (parsed === null) throw new PluginMissionError('invalid', `\`${key}\` is not a time bound`);
  return parsed;
}

export function missionControlFor(scope: MissionControlCallerScope): ScopedMissionControl {
  const { pluginId, viewer } = scope;
  const job = viewer?.id === `${PLUGIN_OWNER_PREFIX}${pluginId}`;
  const db = () => scopedDb(viewer);

  const visible = (missionId: unknown) => {
    if (typeof missionId !== 'string' || !missionId) throw new PluginMissionError('invalid', 'a mission id is required');
    const mission = db().getMission(missionId);
    if (!mission) throw new PluginMissionError('not_found', 'mission not found');
    return mission;
  };
  // The anonymous first-run caller has no account to answer for: it never acts.
  const actor = (): DbViewer => {
    if (!viewer) throw new PluginMissionError('forbidden', 'an authenticated caller is required');
    return viewer;
  };
  // A request needs the right on the caller's own account; a job acts as the plugin.
  const accountAllows = (rights: readonly string[]): void => {
    if (job) return;
    if (!rights.some((right) => pluginCallerAllows(viewer, right))) {
      throw new PluginMissionError('forbidden', `the caller lacks ${rights.map((r) => `\`${r}\``).join(' or ')}`);
    }
  };

  return {
    async send(missionId, text) {
      actor();
      const mission = visible(missionId);
      if (typeof text !== 'string' || !text.trim() || text.length > PLUGIN_SEND_MAX_CHARS) {
        throw new PluginMissionError('invalid', `text must be a non-empty string of at most ${PLUGIN_SEND_MAX_CHARS} characters`);
      }
      assertSpawnAllowed(pluginId);
      const { sendToAgent, respawnWithResume, BackendExhaustedError } = await import('../agent.js');
      const { cooldownReason } = await import('../backend-fallback.js');
      // Not the human's bubble: the chat shows who spoke.
      const origin = { kind: 'system' as const, from: `plugin:${pluginId}`, mission_id: null };
      try {
        const outcome = await sendToAgent(mission.id, text, undefined, origin);
        if (outcome === 'turn_in_flight') {
          throw new PluginMissionError('turn_in_progress', 'a turn is in progress — wait for it to finish before sending');
        }
        if (outcome === 'no_live_process') {
          // The process died but the mission and its provider session survive: resume in place.
          const resumed = await respawnWithResume(mission.id, text, undefined, origin);
          if (!resumed) throw new PluginMissionError('not_running', 'the mission has no live process and cannot be resumed');
          return { resumed: true };
        }
        return { resumed: false };
      } catch (err) {
        if (err instanceof PluginMissionError) throw err;
        if (err instanceof BackendExhaustedError) throw new PluginMissionError('backend_exhausted', `backend ${err.backend} is ${cooldownReason(err.backend)}`);
        throw new PluginMissionError('failed', (err as Error).message);
      }
    },

    async rename(missionId, title) {
      actor();
      const mission = visible(missionId);
      if (title !== null && (typeof title !== 'string' || title.length > PLUGIN_TITLE_MAX_CHARS)) {
        throw new PluginMissionError('invalid', `title must be null or a string of at most ${PLUGIN_TITLE_MAX_CHARS} characters`);
      }
      const clean = title === null ? null : title.replace(/\s+/g, ' ').trim() || null;
      // The plugin's echo is recognisable: the event carries its id as origin.
      dbApi.setMissionTitle(mission.id, clean, { kind: 'plugin', id: pluginId });
      return { title: clean };
    },

    async kill(missionId) {
      actor();
      const mission = visible(missionId);
      const { killAgent } = await import('../agent.js');
      const outcome = killAgent(mission.id, { source: `plugin ${pluginId}: missions.kill`, actor: viewer?.id ?? null });
      if (outcome === 'not_found') throw new PluginMissionError('not_running', 'no running agent for that mission');
      return { outcome };
    },

    async summarize(missionId, opts = {}) {
      actor();
      const mission = visible(missionId);
      assertSpawnAllowed(pluginId);
      const { summarizeMission } = await import('../summary.js');
      try {
        const out = await summarizeMission(mission.id, { force: opts.force === true });
        return { summary: out.summary, cached: out.cached };
      } catch (err) {
        throw new PluginMissionError('failed', (err as Error).message);
      }
    },

    async fork(missionId, input) {
      actor();
      accountAllows(['missions:spawn']);
      const mission = visible(missionId);
      if (typeof input?.to !== 'string' || !input.to.trim()) throw new PluginMissionError('invalid', '`to` (target agent) is required');
      if (input.message !== undefined && typeof input.message !== 'string') throw new PluginMissionError('invalid', '`message` must be a string');
      assertSpawnAllowed(pluginId);
      const { forkMission } = await import('../summary.js');
      try {
        const out = await forkMission({ sourceMissionId: mission.id, targetAgent: input.to, continuation: input.message });
        return { missionId: out.missionId, cached: out.cached, ...(scope.transcript ? { summary: out.summary } : {}) };
      } catch (err) {
        throw new PluginMissionError('failed', (err as Error).message);
      }
    },

    async search(q, filter = {}) {
      if (typeof q !== 'string' || q.length > SEARCH_QUERY_MAX_CHARS) {
        throw new PluginMissionError('invalid', `q must be a string of at most ${SEARCH_QUERY_MAX_CHARS} characters`);
      }
      const { dbApi } = await import('../db.js');
      const query = q.trim();
      if (!query) return { q: '', count: 0, hits: [], progress: dbApi.missionSearchProgress() };
      let agents: string[] | undefined;
      if (filter.agent !== undefined) agents = [String(filter.agent)];
      else if (filter.project !== undefined) {
        const { listAgents } = await import('../agent.js');
        agents = listAgents().filter((a) => a.project === filter.project).map((a) => a.name);
      }
      const hits = db().searchMissions({
        q: query, agents,
        since: timeBound(filter.since, 'since'), until: timeBound(filter.until, 'until'),
        limit: asPositiveLimit(filter.limit, 30, 200),
      });
      return { q: query, count: hits.length, hits, progress: dbApi.missionSearchProgress() };
    },

    async stopScope(target) {
      const caller = actor();
      accountAllows(['missions:stop', 'missions:spawn']);
      const { StopBodySchema, stopScope, UnknownScopeError } = await import('../scope-stop.js');
      const parsed = StopBodySchema.safeParse(target);
      if (!parsed.success) throw new PluginMissionError('invalid', 'expected { agent: NAME } or { project: SLUG }');
      try {
        // A non-superadmin only ever stops its own rows (a job: the plugin's).
        return stopScope(parsed.data, { owner: caller.isSuperadmin ? undefined : caller.id, by: `plugin:${pluginId}` });
      } catch (err) {
        if (err instanceof UnknownScopeError) throw new PluginMissionError('not_found', err.message);
        throw new PluginMissionError('failed', (err as Error).message);
      }
    },

    traces: {
      async get(id, opts = {}) {
        if (typeof id !== 'string' || !id) throw new PluginMissionError('invalid', 'a trace or mission id is required');
        return buildTraceView(db(), id, {
          spanLimit: Math.min(asPositiveLimit(opts.spanLimit, 500, 2000), 2000),
          payload: scope.transcript && opts.payload === true,
          // `missions:read` sees the shape of a trace, not what the agents said.
          redactContent: !scope.transcript,
        });
      },
    },
  };
}
