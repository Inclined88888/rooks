/**
 * The outcome of each idea, keyed by `project_todo.id`. Deleting the idea
 * deletes its outcome (`ON DELETE CASCADE`, `foreign_keys` is on).
 */
import { db } from '../../db.js';
import { TODO_OUTCOME_DDL } from '../../todo-outcome-migration.js';
import type { TodoResolution } from './vocabulary.js';

export type TodoOutcome = {
  resolution: TodoResolution | null;
  /** Note for the idea's author, PUBLIC (sent out with `todo_resolved`),
   *  unlike the idea's `notes`, which never leave Timon. */
  public_note: string | null;
  /** `TIM-…` / `SUG-…` this idea duplicates; only with resolution `duplicate`. */
  duplicate_of: string | null;
};

export const NO_OUTCOME: TodoOutcome = Object.freeze({ resolution: null, public_note: null, duplicate_of: null });

/** Fresh installs: the core migration only creates the table when it has columns to move. */
export function ensureOutcomeTable(): void {
  db.exec(TODO_OUTCOME_DDL);
}

export function getOutcome(todoId: number): TodoOutcome {
  const row = db.prepare(
    `SELECT resolution, public_note, duplicate_of FROM todo_outcome WHERE todo_id = ?`,
  ).get(todoId) as TodoOutcome | undefined;
  return row ?? NO_OUTCOME;
}

export function putOutcome(todoId: number, outcome: TodoOutcome): void {
  db.prepare(`
    INSERT INTO todo_outcome (todo_id, resolution, public_note, duplicate_of, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(todo_id) DO UPDATE SET
      resolution = excluded.resolution, public_note = excluded.public_note,
      duplicate_of = excluded.duplicate_of, updated_at = excluded.updated_at`,
  ).run(todoId, outcome.resolution, outcome.public_note, outcome.duplicate_of, Date.now());
}
