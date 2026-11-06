'use client';

import { cn } from '@/lib/utils';

/** Same threshold as the text gauge it replaces: red from 40 % on. */
export const CONTEXT_RING_DANGER_PCT = 40;

/** `200k`, `128k`, `8k`, `1M`, `1.5M`: short enough for the ring's centre. */
export function fmtContextLimit(n: number): string {
  if (n >= 1_000_000) return String(Number((n / 1_000_000).toFixed(1))) + 'M';
  if (n >= 1_000) return String(Math.round(n / 1_000)) + 'k';
  return String(n);
}

/**
 * The context window as a ring that fills up, its maximum size in the
 * centre (TODO #431). `limit` null = unknown window: an empty, neutral ring
 * with nothing in the centre, never a made-up percentage.
 */
export function ContextRing({
  used,
  limit,
  label,
  size = 24,
  busy = false,
}: {
  used: number;
  limit: number | null;
  /** Accessible name; the caller's tooltip text. */
  label: string;
  size?: number;
  /** A compaction runs: an arc turns around the ring, visible with the
   *  gauge's panel closed. */
  busy?: boolean;
}) {
  const pct = limit && limit > 0 ? Math.min(100, Math.max(0, Math.round((used / limit) * 100))) : null;
  const danger = pct !== null && pct >= CONTEXT_RING_DANGER_PCT;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const center = limit && limit > 0 ? fmtContextLimit(limit) : null;
  return (
    <span
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      aria-busy={busy || undefined}
      data-danger={danger ? 'true' : undefined}
      data-busy={busy ? 'true' : undefined}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center',
        danger ? 'text-destructive' : 'text-foreground/70',
      )}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-muted-foreground/25"
        />
        {pct !== null && pct > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${(circumference * pct) / 100} ${circumference}`}
          />
        )}
      </svg>
      {busy && (
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          aria-hidden="true"
          className="absolute inset-0 text-primary motion-safe:animate-spin motion-reduce:animate-pulse"
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${circumference * 0.25} ${circumference}`}
          />
        </svg>
      )}
      {center && (
        <span
          aria-hidden="true"
          className={cn(
            'absolute inset-0 flex items-center justify-center font-medium leading-none tabular-nums',
            size >= 24 ? 'text-[7.5px]' : 'text-[7px]',
          )}
        >
          {center}
        </span>
      )}
    </span>
  );
}
