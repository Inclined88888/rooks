/**
 * Reading of the video-factory production progress.
 *
 * The coupling goes ONE WAY ONLY: TIMON opens the video-factory database
 * read-only, video-factory ignores that TIMON exists. No write,
 * no migration — the database belongs to the neighbouring repo, which must stay
 * autonomous. If the file does not exist (repo not initialised), we simply
 * return "unavailable": it is not an error, it is a project that
 * has not produced yet.
 *
 * The display rules (ratio, ETA, freeze threshold) are those of
 * `video-factory/src/lib/progress.ts`, reproduced here rather than imported:
 * crossing the border between the two repos for three functions would cost more
 * than keeping them aligned.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { settingStr } from './settings.js';

/** Beyond this, the row describes a dead or frozen process — no longer progress. */
export const VF_STALE_MS = 2 * 60 * 1000;

export type VfProgressUnit = 'item' | 'sec';

export type VfJobProgress = {
  job_id: string;
  theme: string | null;
  format: string | null;
  status: string | null;
  stage: string;
  phase: string | null;
  current: number;
  total: number;
  unit: VfProgressUnit;
  label: string | null;
  started_at: number;
  updated_at: number;
  /** Fraction done, or null as long as the denominator is unknown — in
   *  that case the UI scrolls instead of inventing a percentage. */
  ratio: number | null;
  /** Estimated remaining. null as long as no step has been passed: extrapolating
   *  from zero measurements would be an invention. */
  eta_ms: number | null;
  /** No update since VF_STALE_MS → frozen, not "in progress". */
  stale: boolean;
};

export type VfProgressSnapshot = {
  available: boolean;
  now: number;
  jobs: VfJobProgress[];
};

export function vfDbPath(): string {
  return (
    settingStr('VF_DB_PATH')

  );
}

/** Handle reused between two polls (the rail queries every second), closed
 *  as soon as a read fails so that a recreated file is reopened on the next
 *  one rather than serving a dead handle. */
let handle: Database.Database | null = null;
let handlePath: string | null = null;

function closeHandle(): void {
  try { handle?.close(); } catch { /* already closed */ }
  handle = null;
  handlePath = null;
}

function openDb(): Database.Database | null {
  const path = vfDbPath();
  if (handle && handlePath === path) return handle;
  if (handle) closeHandle();
  if (!path || !existsSync(path)) return null;
  try {
    // readonly + fileMustExist: no file creation, no write
    // possible even by accident. The video-factory WAL makes this read
    // non-blocking while a production writes.
    handle = new Database(path, { readonly: true, fileMustExist: true });
    handlePath = path;
    return handle;
  } catch {
    closeHandle();
    return null;
  }
}

function ratioOf(current: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.min(1, Math.max(0, current / total));
}

function etaOf(row: { current: number; total: number; started_at: number }, now: number): number | null {
  if (row.total <= 0 || row.current <= 0 || row.current >= row.total) return null;
  const elapsed = now - row.started_at;
  if (elapsed <= 0) return null;
  return Math.round((elapsed / row.current) * (row.total - row.current));
}

type RawRow = {
  job_id: string;
  stage: string;
  phase: string | null;
  current: number;
  total: number;
  unit: string;
  label: string | null;
  started_at: number;
  updated_at: number;
  theme: string | null;
  format: string | null;
  status: string | null;
};

/**
 * Progress in flight, freshest first. Zero or one row per job:
 * `job_progress` is an UPSERT purged at the end of a step, so an empty list is
 * the NORMAL state between two productions — not an outage.
 */
export function readVideoFactoryProgress(): VfProgressSnapshot {
  const now = Date.now();
  const db = openDb();
  if (!db) return { available: false, now, jobs: [] };
  try {
    const rows = db
      .prepare(
        `SELECT p.job_id, p.stage, p.phase, p.current, p.total, p.unit, p.label,
                p.started_at, p.updated_at, j.theme, j.format, j.status
           FROM job_progress p JOIN jobs j ON j.id = p.job_id
          ORDER BY p.updated_at DESC`,
      )
      .all() as RawRow[];
    return {
      available: true,
      now,
      jobs: rows.map((r) => ({
        job_id: r.job_id,
        theme: r.theme,
        format: r.format,
        status: r.status,
        stage: r.stage,
        phase: r.phase,
        current: Number(r.current),
        total: Number(r.total),
        unit: r.unit === 'sec' ? 'sec' : 'item',
        label: r.label,
        started_at: Number(r.started_at),
        updated_at: Number(r.updated_at),
        ratio: ratioOf(Number(r.current), Number(r.total)),
        eta_ms: etaOf(
          { current: Number(r.current), total: Number(r.total), started_at: Number(r.started_at) },
          now,
        ),
        stale: now - Number(r.updated_at) > VF_STALE_MS,
      })),
    };
  } catch {
    // Database being recreated, missing schema (new repo), truncated file:
    // the rail must disappear, not show an error.
    closeHandle();
    return { available: false, now, jobs: [] };
  }
}
