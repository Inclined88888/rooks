/**
 * Date of a note — same rule as vault-graph (`src/dates.mjs`).
 *
 * Order: frontmatter `created`/`date`, then a date at the head of the file name,
 * then min(ctime, mtime) of the filesystem.
 */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export type DateSource = 'frontmatter' | 'filename' | 'stamp' | 'none';

export interface DateTally {
  frontmatter: number;
  filename: number;
  stamp: number;
  none: number;
}

export function isRealDay(s: string): boolean {
  if (!ISO_DAY.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function localDay(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

export function day10(v: unknown): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return localDay(v.getTime());
  const s = typeof v === 'string' ? v.slice(0, 10) : '';
  return isRealDay(s) ? s : '';
}

const NAME_DAY = /^(\d{4}-\d{2}-\d{2})(?![\d-])/;

export function nameDay(basename: string): string {
  const m = NAME_DAY.exec(String(basename || ''));
  const hit = m?.[1];
  return hit && isRealDay(hit) ? hit : '';
}

export function stampDay(ctimeMs: number, mtimeMs: number): string {
  const c = Number(ctimeMs) || 0;
  const m = Number(mtimeMs) || 0;
  const pick = c && m ? Math.min(c, m) : (c || m);
  return pick ? localDay(pick) : '';
}

export function resolveCreated(
  fm: Record<string, unknown> | null | undefined,
  basename: string,
  ctimeMs: number,
  mtimeMs: number,
): { day: string; source: DateSource } {
  const f = day10(fm?.created) || day10(fm?.date);
  if (f) return { day: f, source: 'frontmatter' };
  const n = nameDay(basename);
  if (n) return { day: n, source: 'filename' };
  const s = stampDay(ctimeMs, mtimeMs);
  if (s) return { day: s, source: 'stamp' };
  return { day: '', source: 'none' };
}

export function dateTally(): DateTally {
  return { frontmatter: 0, filename: 0, stamp: 0, none: 0 };
}
