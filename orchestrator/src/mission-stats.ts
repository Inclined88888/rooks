/**
 * Backfill of `mission_stats` for the missions that predate the table.
 *
 * A home upgraded in place holds millions of events (2.2M on the maintainer's install): folding
 * them in at boot, in one go, would hold the daemon for over a second — and a
 * cold page cache makes it worse. So the work runs on a timer, in slices of a
 * few milliseconds, newest missions first, and every slice is one IMMEDIATE
 * transaction: what it reads cannot move under what it writes.
 *
 * How the two writers share a row (schema in db.ts): seeding a mission records
 * `backfill_upto`, its newest event id at that instant, with `ready = 0`. The
 * insert trigger counts everything after it; this module folds in the ids up
 * to it, `CHUNK` rows at a time, then flips `ready`. Readers ignore a row until
 * then. Idempotent: a restart resumes from `backfill_cursor`, and a mission
 * already seeded is never seeded twice.
 */
import { db } from './db.js';
import { resultModelOf } from './result-model.js';

/** Missions seeded per pass, newest first. */
const SEED_BATCH = 500;
/** Events folded per transaction: ~2 ms on a warm 2.2M-event home. */
const CHUNK = 5_000;
/** Work per tick before handing the event loop back. */
const SLICE_MS = 15;
/** Pause between ticks: the API keeps most of the loop while this runs. */
const PAUSE_MS = 40;
/** Let the boot settle before the first tick. */
const START_DELAY_MS = 5_000;
/** After an error (a busy database): retry, but not in a tight loop. */
const ERROR_DELAY_MS = 30_000;

type PendingRow = {
  mission_id: string;
  backfill_cursor: number;
  backfill_upto: number;
  event_count: number;
  last_event_at: number | null;
  last_result_id: number | null;
  last_user_id: number | null;
  last_result_model: string | null;
};

type ChunkAgg = { n: number; ts: number | null; r: number | null; u: number | null; last: number | null };

const seedStmt = db.prepare(
  `INSERT OR IGNORE INTO mission_stats (mission_id, ready, backfill_cursor, backfill_upto)
   SELECT m.id, 0, 0, COALESCE((SELECT MAX(e.id) FROM events e WHERE e.mission_id = m.id), 0)
     FROM missions m
    WHERE NOT EXISTS (SELECT 1 FROM mission_stats s WHERE s.mission_id = m.id)
    ORDER BY m.started_at DESC
    LIMIT ?`,
);
const pickPendingStmt = db.prepare(
  `SELECT mission_id, backfill_cursor, backfill_upto, event_count, last_event_at,
          last_result_id, last_user_id, last_result_model
     FROM mission_stats WHERE ready = 0 LIMIT 1`,
);
const pendingRowStmt = db.prepare(
  `SELECT mission_id, backfill_cursor, backfill_upto, event_count, last_event_at,
          last_result_id, last_user_id, last_result_model
     FROM mission_stats WHERE mission_id = ? AND ready = 0`,
);
const chunkStmt = db.prepare(
  `SELECT COUNT(*) AS n, MAX(timestamp) AS ts,
          MAX(CASE WHEN type = 'result' THEN id END) AS r,
          MAX(CASE WHEN type = 'user' THEN id END) AS u,
          MAX(id) AS last
     FROM (SELECT id, type, timestamp FROM events
            WHERE mission_id = ? AND id > ? AND id <= ?
            ORDER BY id LIMIT ?)`,
);
const eventPayloadStmt = db.prepare(`SELECT payload FROM events WHERE id = ?`);
const writeStmt = db.prepare(
  `UPDATE mission_stats SET ready = ?, backfill_cursor = ?, event_count = ?, last_event_at = ?,
          last_result_id = ?, last_user_id = ?, last_result_model = ?
    WHERE mission_id = ? AND ready = 0`,
);
const countPendingStmt = db.prepare(
  `SELECT (SELECT COUNT(*) FROM mission_stats WHERE ready = 0)
        + (SELECT COUNT(*) FROM missions m WHERE NOT EXISTS
             (SELECT 1 FROM mission_stats s WHERE s.mission_id = m.id)) AS n`,
);

const maxOf = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.max(a, b);

/** Folds one chunk of one mission's older events into its row. */
const advance = db.transaction((missionId: string): void => {
  // Re-read inside the transaction: the trigger may have moved the row since
  // it was picked, and only this snapshot is safe to add to.
  const row = pendingRowStmt.get(missionId) as PendingRow | undefined;
  if (!row) return;
  const agg = chunkStmt.get(row.mission_id, row.backfill_cursor, row.backfill_upto, CHUNK) as ChunkAgg;
  const cursor = agg.last ?? row.backfill_upto;
  const done = agg.n < CHUNK || cursor >= row.backfill_upto;
  const lastResultId = maxOf(row.last_result_id, agg.r);
  let model = row.last_result_model;
  // A result written after the seed already carries its model (trigger); one
  // from before it is read once, when the row is complete.
  if (done && lastResultId !== null && lastResultId <= row.backfill_upto) {
    const ev = eventPayloadStmt.get(lastResultId) as { payload: string } | undefined;
    model = ev ? resultModelOf(ev.payload) : null;
  }
  writeStmt.run(
    done ? 1 : 0,
    cursor,
    row.event_count + agg.n,
    maxOf(row.last_event_at, agg.ts),
    lastResultId,
    maxOf(row.last_user_id, agg.u),
    model,
    row.mission_id,
  );
});

/**
 * Runs backfill work for about `budgetMs`. Returns true while work remains.
 * Exported for tests and for a caller that wants to drain it synchronously.
 */
export function backfillMissionStatsStep(budgetMs = SLICE_MS): boolean {
  const deadline = performance.now() + budgetMs;
  do {
    const pending = pickPendingStmt.get() as PendingRow | undefined;
    if (pending) {
      advance.immediate(pending.mission_id);
      continue;
    }
    if (seedStmt.run(SEED_BATCH).changes === 0) return false;
  } while (performance.now() < deadline);
  return true;
}

/** Missions whose stats are not usable yet (seeded or not). */
export function missionStatsBackfillPending(): number {
  return (countPendingStmt.get() as { n: number }).n;
}

/** Starts the background backfill; returns its stop function (module effect). */
export function startMissionStatsBackfill(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const schedule = (ms: number) => {
    timer = setTimeout(tick, ms);
    timer.unref?.();
  };
  const tick = () => {
    timer = null;
    if (stopped) return;
    let more: boolean;
    try {
      more = backfillMissionStatsStep();
    } catch (err) {
      console.warn(`[mission-stats] backfill paused: ${(err as Error).message}`);
      schedule(ERROR_DELAY_MS);
      return;
    }
    if (more) schedule(PAUSE_MS);
  };
  schedule(START_DELAY_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
