/**
 * Module `@timon/db` — the SQLite database and its cold archive.
 *
 * Tier `core`, and the first of all: `db.ts` opens the database and plays
 * its additive migrations at module LOAD time, not in `apply()`. The `db`
 * service it publishes is therefore not an abstraction — it's an ordering
 * token: any module that injects it is guaranteed the schema is up to date
 * before reading anything.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { dbApi } from '../../db.js';
import { attachEventsArchiveIfPresent, startEventsArchive } from '../../events-archive.js';
import { backfillTraceIdsAtBoot } from '../../trace-backfill.js';
import { startMissionStatsBackfill } from '../../mission-stats.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    db: typeof dbApi;
  }
}

export const manifest: ModuleManifest = { name: '@timon/db', tier: 'core' };
export const name = manifest.name;

export function apply(ctx: Context): void {
  ctx.provide('db', dbApi);

  // Attach the archive BEFORE anything reads events: otherwise an already
  // archived mission would display empty until the job's first run.
  attachEventsArchiveIfPresent();
  // Fill `trace_id` on rows that predate W.0, so every reader of the trace
  // tree can assume it is non-null (PRD workflows §12.2). Batched, idempotent,
  // never throws.
  backfillTraceIdsAtBoot();
  ctx.effect(() => startEventsArchive());
  // Fold the events that predate `mission_stats` into it, in slices of a few
  // ms on a timer: the mission list reads the subqueries until a row is ready.
  ctx.effect(() => startMissionStatsBackfill());
}
