/**
 * Width of the Kanban grid — four status columns, plus those a plugin adds
 * in `kanban.column`.
 *
 * In a module of its own, and not an interpolation in the JSX, for two
 * reasons. Tailwind only generates the classes it READS: `md:grid-cols-${n}`
 * produces nothing, the grid would stay at four columns and the fifth would
 * overflow without any build saying so. And it is the only part of the board
 * that can be tested without mounting the page.
 */

/** PENDING / IN_PROGRESS / DONE / BLOCKED: the statuses of a task. */
export const KANBAN_NATIVE_COLUMNS = 4;

/** Literal classes, readable by Tailwind. */
const GRID_CLASS: Readonly<Partial<Record<number, string>>> = Object.freeze({
  4: 'md:grid-cols-4',
  5: 'md:grid-cols-5',
  6: 'md:grid-cols-6',
  7: 'md:grid-cols-7',
  8: 'md:grid-cols-8',
});

const MAX_COLUMNS = 8;

/**
 * Grid class for `extra` plugin columns.
 *
 * Beyond eight columns the last class is kept: the grid stops widening, the
 * columns shrink. It is the least bad fallback — refusing to paint one would
 * make the plugin vanish without explanation.
 */
export function kanbanGridClass(extra: number): string {
  const total = Math.min(KANBAN_NATIVE_COLUMNS + Math.max(0, extra), MAX_COLUMNS);
  return GRID_CLASS[total] ?? 'md:grid-cols-4';
}
