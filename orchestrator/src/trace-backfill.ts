/**
 * Boot backfill of `trace_id` (docs/PRD-WORKFLOWS.md §3.1, invariant §12.2).
 *
 * Every mission created before W.0 has a NULL `trace_id`. The causal root is
 * recovered from the lineage already denormalised on the row:
 * `parent_mission_id`, then `forked_from`, then `task_id → tasks.creator_mission_id`.
 * A mission that nothing precedes is its own root:
 * `trace_id = COALESCE(trace_id, ancestor.trace_id, id)`.
 *
 * Idempotent (only NULL rows are touched) and never blocking: batches of
 * BATCH rows, one short transaction each, like `events-archive`. Any error is
 * logged and swallowed — a boot must never fail on a bookkeeping column.
 */
import { db } from './db.js';

/** Same batch size as the events archive: big enough to finish on a large
 *  base, small enough that no transaction holds the write lock for long. */
const BATCH = 5_000;

export type TraceBackfillReport = { missions: number; tasks: number; messages: number };

// Trace of the closest ancestor THAT EXISTS. CASE (not COALESCE on the three
// traces) so a child whose parent row exists but is still unresolved waits
// for it instead of borrowing the trace of a lower-priority ancestor.
const ANCESTOR_TRACE = `
  CASE
    WHEN EXISTS (SELECT 1 FROM missions p WHERE p.id = m.parent_mission_id)
      THEN (SELECT p.trace_id FROM missions p WHERE p.id = m.parent_mission_id)
    WHEN EXISTS (SELECT 1 FROM missions f WHERE f.id = m.forked_from)
      THEN (SELECT f.trace_id FROM missions f WHERE f.id = m.forked_from)
    WHEN EXISTS (SELECT 1 FROM tasks t JOIN missions c ON c.id = t.creator_mission_id WHERE t.id = m.task_id)
      THEN (SELECT c.trace_id FROM tasks t JOIN missions c ON c.id = t.creator_mission_id WHERE t.id = m.task_id)
  END`;
const HAS_ANCESTOR = `(
  EXISTS (SELECT 1 FROM missions p WHERE p.id = m.parent_mission_id)
  OR EXISTS (SELECT 1 FROM missions f WHERE f.id = m.forked_from)
  OR EXISTS (SELECT 1 FROM tasks t JOIN missions c ON c.id = t.creator_mission_id WHERE t.id = m.task_id))`;

/** Missions with no ancestor row at all → their own root. */
const rootsStmt = db.prepare(
  `UPDATE missions SET trace_id = id
    WHERE id IN (SELECT m.id FROM missions m
                  WHERE m.trace_id IS NULL AND NOT ${HAS_ANCESTOR}
                  ORDER BY m.rowid LIMIT ?)`,
);
/** Missions whose closest existing ancestor is already resolved. */
const inheritStmt = db.prepare(
  `UPDATE missions SET trace_id = (SELECT ${ANCESTOR_TRACE} FROM missions m WHERE m.id = missions.id)
    WHERE id IN (SELECT m.id FROM missions m
                  WHERE m.trace_id IS NULL AND (${ANCESTOR_TRACE}) IS NOT NULL
                  ORDER BY m.rowid LIMIT ?)`,
);
/** Whatever is left after inheritance converged: lineage cycles or ancestors
 *  that can never resolve. Each becomes its own root rather than staying NULL. */
const leftoversStmt = db.prepare(
  `UPDATE missions SET trace_id = id
    WHERE id IN (SELECT id FROM missions WHERE trace_id IS NULL ORDER BY rowid LIMIT ?)`,
);
const tasksStmt = db.prepare(
  `UPDATE tasks SET trace_id = (SELECT c.trace_id FROM missions c WHERE c.id = tasks.creator_mission_id)
    WHERE id IN (SELECT t.id FROM tasks t JOIN missions c ON c.id = t.creator_mission_id
                  WHERE t.trace_id IS NULL AND c.trace_id IS NOT NULL
                  ORDER BY t.rowid LIMIT ?)`,
);
const messagesStmt = db.prepare(
  `UPDATE agent_messages SET trace_id = (SELECT c.trace_id FROM missions c WHERE c.id = agent_messages.from_mission)
    WHERE id IN (SELECT a.id FROM agent_messages a JOIN missions c ON c.id = a.from_mission
                  WHERE a.trace_id IS NULL AND c.trace_id IS NOT NULL
                  ORDER BY a.rowid LIMIT ?)`,
);

/** Run `stmt` batch after batch, one transaction per batch, until it changes
 *  nothing. Returns the number of rows updated. */
function drain(stmt: import('better-sqlite3').Statement): number {
  const step = db.transaction((): number => stmt.run(BATCH).changes);
  let total = 0;
  for (;;) {
    const n = step();
    if (n === 0) return total;
    total += n;
  }
}

/** Fill every NULL `trace_id`. Safe to call at every boot. */
export function backfillTraceIds(): TraceBackfillReport {
  const report: TraceBackfillReport = { missions: 0, tasks: 0, messages: 0 };
  report.missions += drain(rootsStmt);
  // Inheritance converges level by level (a grand-child resolves once its
  // parent did); `drain` already loops until a pass changes nothing.
  report.missions += drain(inheritStmt);
  report.missions += drain(leftoversStmt);
  report.tasks = drain(tasksStmt);
  report.messages = drain(messagesStmt);
  return report;
}

/** Boot entry point: never throws, logs only when something was filled. */
export function backfillTraceIdsAtBoot(): TraceBackfillReport | null {
  try {
    const report = backfillTraceIds();
    if (report.missions || report.tasks || report.messages) {
      console.log(
        `[trace] backfilled trace_id: ${report.missions} missions, ${report.tasks} tasks, ${report.messages} messages`,
      );
    }
    return report;
  } catch (err) {
    console.warn(`[trace] trace_id backfill failed (will retry next boot): ${(err as Error).message}`);
    return null;
  }
}
