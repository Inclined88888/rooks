'use client';

/**
 * The "Video production" block of the chat's right rail, modelled on the
 * Grepai block.
 *
 * Shows the progress WITHIN the current stage of each video-factory job. The
 * job status places the production between stages, it says nothing of what
 * happens inside one: `visuals` lasts ten minutes over fourteen shots, and
 * without this bar nothing tells "at shot 2" from "at shot 13".
 *
 * The display rules come from the video-factory repo (src/lib/progress.ts):
 *  - a percentage ONLY when the denominator is known, otherwise a sliding
 *    cursor: it proves the process is alive, it does not invent progress;
 *  - no ETA until a first step has been passed;
 *  - beyond 2 min without an update, the row is "stalled": a killed process
 *    leaves its row behind, it must not read as work in progress.
 *
 * The block disappears when there is no row: that is the NORMAL state between
 * two productions, not a failure.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

type VfJob = {
  job_id: string;
  theme: string | null;
  format: string | null;
  status: string | null;
  stage: string;
  phase: string | null;
  current: number;
  total: number;
  unit: 'item' | 'sec';
  label: string | null;
  started_at: number;
  updated_at: number;
  ratio: number | null;
  eta_ms: number | null;
  stale: boolean;
};

type Snapshot = { available: boolean; now: number; jobs: VfJob[] };

/** The read is trivial (a join over two tables): we can follow at the pace
 *  the production writes. */
const POLL_MS = 1000;
const BAR_WIDTH = 14;

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}`;
}

/** `sec` = seconds of media, `item` = a raw counter. Mixing the two up would
 *  show "12/28" for twelve seconds rendered out of twenty-eight. */
function formatCounter(j: VfJob): string {
  if (j.total <= 0) return String(j.current);
  return j.unit === 'sec'
    ? `${formatDuration(j.current * 1000)}/${formatDuration(j.total * 1000)}`
    : `${j.current}/${j.total}`;
}

/** A filled/empty bar when the denominator is known; otherwise a sweeping
 *  cursor, animated locally so it does not freeze between two polls. */
function Bar({ job, tick }: { job: VfJob; tick: number }) {
  if (job.ratio === null) {
    // A stalled job must not keep sliding its cursor: that motion means
    // "alive", it would lie about a dead process.
    const pos = job.stale ? 0 : Math.floor((tick / 400) % BAR_WIDTH);
    return (
      <span className="relative inline-block h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted">
        <span
          className={cn('absolute inset-y-0 rounded-full', job.stale ? 'bg-muted-foreground/40' : 'bg-primary')}
          style={{ left: `${(pos / BAR_WIDTH) * 100}%`, width: `${100 / BAR_WIDTH}%` }}
        />
      </span>
    );
  }
  // A drawn bar rather than block characters: those only line up in a fixed-width face.
  return (
    <span className="relative inline-block h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted">
      <span
        className={cn('absolute inset-y-0 left-0 rounded-full', job.stale ? 'bg-muted-foreground/60' : 'bg-primary')}
        style={{ width: `${Math.round(job.ratio * 100)}%` }}
      />
    </span>
  );
}

function LigneJob({ job, tick }: { job: VfJob; tick: number }) {
  const titre = job.theme?.trim() || job.job_id.slice(0, 8);
  const etape = job.phase ? `${job.stage} · ${job.phase}` : job.stage;
  return (
    <li className="space-y-0.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[11.5px]" title={titre}>{titre}</span>
        {job.ratio !== null && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {Math.round(job.ratio * 100)}%
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <Bar job={job} tick={tick} />
        <span className="text-[10.5px] tabular-nums text-muted-foreground/80">
          {formatCounter(job)}
        </span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 text-[10.5px] text-muted-foreground/70">
        <span>{etape}</span>
        {job.eta_ms !== null && !job.stale && <span>{t('videoFactoryPanel.remaining', { duration: formatDuration(job.eta_ms) })}</span>}
        {job.stale && (
          <span className="text-amber-400/90">
            {t('videoFactoryPanel.stalledFor', { duration: formatDuration(Math.max(0, tick - job.updated_at)) })}
          </span>
        )}
      </div>
      {job.label && (
        <p className="truncate text-[10.5px] text-muted-foreground/60" title={job.label}>
          {job.label}
        </p>
      )}
    </li>
  );
}

export function VideoFactoryPanel({ slug }: { slug: string | null }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  // Local clock: slides the indeterminate cursor and ages the "stalled" label
  // between two polls, without waiting for a server answer to move.
  const [tick, setTick] = useState(() => Date.now());
  // Server/browser clock skew: the timestamps come from the database (the
  // machine's epoch), the local clock is aligned on it.
  const skew = useRef(0);

  const actif = slug === 'video-factory';

  const load = useCallback(async () => {
    if (!actif) return;
    try {
      const r = await fetch('/api/ui/video-factory/progress', { cache: 'no-store' });
      if (!r.ok) return;
      const j = (await r.json()) as Snapshot;
      skew.current = j.now - Date.now();
      setSnap(j);
    } catch {
      /* Silent: one missed poll a second must not break the rail. */
    }
  }, [actif]);

  useEffect(() => {
    if (!actif) return;
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [actif, load]);

  useEffect(() => {
    if (!actif) return;
    const t = setInterval(() => setTick(Date.now() + skew.current), 120);
    return () => clearInterval(t);
  }, [actif]);

  // Another project, no database (repo not initialised), or no production
  // running: nothing to show. A permanently empty block would waste the rail.
  if (!actif || !snap?.available || snap.jobs.length === 0) return null;

  const enCours = snap.jobs.filter((j) => !j.stale).length;

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center justify-end gap-2">
        <span
          className={cn(
            'size-1.5 rounded-full',
            enCours > 0 ? 'bg-primary' : 'bg-muted-foreground/40',
          )}
          aria-hidden
        />
      </div>

      <ul className="space-y-2.5">
        {snap.jobs.map((j) => (
          <LigneJob key={j.job_id} job={j} tick={tick} />
        ))}
      </ul>
    </div>
  );
}
