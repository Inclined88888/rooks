/**
 * Which board column a task lands in, as a pure function so the page stays a
 * wiring layer and the tests need no DOM.
 *
 * The status comes from the database at runtime, not from the type system: a
 * row written by an older version or by hand can carry a value the board has
 * no column for (TIM-0101: `CANCELLED`). Indexing the columns with it threw
 * "Cannot read properties of undefined (reading 'push')" and took the whole
 * page down. An unknown status is a task that no longer runs, so it joins DONE
 * — never BLOCKED, which asks for a human.
 */
export const BOARD_STATUSES = ['PENDING', 'IN_PROGRESS', 'DONE', 'BLOCKED'] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

export function columnStatus(status: string): BoardStatus {
  return (BOARD_STATUSES as readonly string[]).includes(status) ? (status as BoardStatus) : 'DONE';
}

export function groupByColumn<T extends { status: string }>(tasks: readonly T[]): Record<BoardStatus, T[]> {
  const byCol: Record<BoardStatus, T[]> = { PENDING: [], IN_PROGRESS: [], DONE: [], BLOCKED: [] };
  for (const t of tasks) byCol[columnStatus(t.status)].push(t);
  return byCol;
}
