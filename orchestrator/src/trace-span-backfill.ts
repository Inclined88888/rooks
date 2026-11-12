/**
 * Explicit, cold replay of raw events into trace spans (PRD workflows §4.2).
 * It is deliberately never called at boot: a mature event journal can be
 * several gigabytes and this index is a convenience, not a startup dependency.
 */
import { db, dbApi } from './db.js';
import { settingInt } from './settings.js';
import { streamJsonSpans } from './backends/stream-json-spans.js';
import { newSpanState } from './trace-recorder.js';
import type { NormalizedEvent } from './backends/types.js';

export type SpanBackfillReport = { missions: number; events: number; spans: number };

/** One mission, atomically: its totals must not outlive a partial rebuild, nor
 *  stay next to a complete one. A mission whose events give no span keeps them. */
const replayMission = db.transaction((missionId: string, traceId: string): { events: number; spans: number } => {
  const state = newSpanState(missionId, traceId);
  let events = 0;
  let spans = 0;
  for (const event of dbApi.listEvents(missionId)) {
    let payload: unknown;
    try { payload = JSON.parse(event.payload); } catch { continue; }
    const ops = streamJsonSpans({ type: event.type, payload } as NormalizedEvent, state, event.id);
    if (ops.length) {
      const changed = dbApi.upsertSpans(ops);
      spans += changed.opened + changed.closed;
    }
    events += 1;
  }
  if (spans > 0) dbApi.clearPrunedSpanTotals(missionId);
  return { events, spans };
});

/** The timeline of one finished mission, after retention removed it. */
export function rebuildMissionSpans(mission: { id: string; trace_id: string | null }): SpanBackfillReport {
  return { missions: 1, ...replayMission(mission.id, mission.trace_id ?? mission.id) };
}

export function backfillTraceSpans(opts: { days?: number; limit?: number } = {}): SpanBackfillReport {
  // Without an explicit window, stop at the retention horizon: what lies beyond
  // it would only be removed again by the next nightly pass.
  const retention = settingInt('ROOKS_TRACE_SPANS_RETENTION_DAYS');
  const days = opts.days ?? (retention > 0 ? retention : undefined);
  const since = days === undefined ? null : Date.now() - days * 86_400_000;
  const limit = Math.max(1, Math.min(1_000, opts.limit ?? 100));
  const rows = db.prepare(
    `SELECT m.id, m.trace_id
       FROM missions m
      WHERE NOT EXISTS (SELECT 1 FROM trace_spans s WHERE s.mission_id = m.id)
        AND (? IS NULL OR m.started_at >= ?)
      ORDER BY m.started_at ASC
      LIMIT ?`,
  ).all(since, since, limit) as Array<{ id: string; trace_id: string | null }>;
  let events = 0;
  let spans = 0;
  for (const mission of rows) {
    const replayed = replayMission(mission.id, mission.trace_id ?? mission.id);
    events += replayed.events;
    spans += replayed.spans;
  }
  return { missions: rows.length, events, spans };
}
