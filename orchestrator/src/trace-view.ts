/**
 * The causal trace of a mission, as `GET /api/trace/:traceId` and the plugin
 * `ctx.traces.get` both serve it. One builder so the two cannot disagree on
 * which missions, spans and sums the caller may see.
 */
import { dbApi } from './db.js';
import type { scopedDb } from './users/scoped-db.js';

export type TraceViewOptions = {
  spanLimit: number;
  payload: boolean;
  /**
   * Blank what was SAID (the mission prompt and its channel metadata, summaries,
   * message bodies, task descriptions, reports and block reasons), keep the skeleton.
   */
  redactContent?: boolean;
};

export const REDACTED_CONTENT = '';

export function buildTraceView(scope: ReturnType<typeof scopedDb>, requested: string, opts: TraceViewOptions) {
  // Accepting a mission id makes the CLI ergonomic while keeping the URL's
  // canonical identity a causal trace id.
  const traceId = scope.getMission(requested)?.trace_id ?? requested;
  const visibleMissions = scope.listMissionsByTrace(traceId);
  if (visibleMissions.length === 0) return undefined;
  const missions = opts.redactContent
    ? visibleMissions.map((m) => ({ ...m, mission: REDACTED_CONTENT, summary: null, source_meta: null }))
    : visibleMissions;
  // Only the missions the caller may see feed the spans AND the sums: a
  // trace can hold another owner's mission, whose cost must not leak.
  const summary = dbApi.summarizeTraceSpans(traceId, missions.map((mission) => mission.id), { limit: opts.spanLimit, payload: opts.payload });
  const { spans: spanCount, ...sums } = summary.aggregates;
  const spans = summary.spans;
  const tasks = opts.redactContent
    ? scope.listTasksByTrace(traceId).map((t) => ({ ...t, description: null, blocked_reason: null, done_comment: null, done_summary: null }))
    : scope.listTasksByTrace(traceId);
  const agentMessages = opts.redactContent
    ? scope.listMessagesByTrace(traceId).map((m) => ({ ...m, payload: REDACTED_CONTENT }))
    : scope.listMessagesByTrace(traceId);
  const aggregates = { ...sums, missions: missions.length };
  return { trace_id: traceId, missions, tasks, agent_messages: agentMessages, spans, spans_total: spanCount, spans_truncated: spanCount > spans.length, spans_pruned: summary.pruned, aggregates };
}
