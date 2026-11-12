import { formatAgeShort, formatRelativeTime } from '@/lib/intl';

/** "3d", "now": a commit's age in the interface language; a clock ahead of the commit reads as now. */
export function ageLabel(ts: number, now: number): string {
  return now - ts < 60_000 ? formatRelativeTime(now, now) : formatAgeShort(now - ts);
}

/** "3 days ago", `il y a 3 j`, and "now" under a minute. */
export function agoLabel(ts: number, now: number): string {
  return formatRelativeTime(Math.min(ts, now), now);
}
