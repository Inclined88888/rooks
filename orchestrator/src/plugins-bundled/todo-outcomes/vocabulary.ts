/**
 * Vocabulary of an idea's outcome, moved verbatim from `project-todo-tags.ts`
 * when the outcome left the core for its plugin (`@timon/todo-outcomes`).
 */
/**
 * Outcome the user gives an idea (mainly a tester report `TIM-…` or suggestion
 * `SUG-…`): it drives the message its author receives outside Timon, through
 * the `todo_resolved` event. A closed list: the receivers of that event
 * (bots, connectors) rely on it.
 */
export const TODO_RESOLUTIONS = ['fixed', 'declined', 'duplicate', 'needs_info', 'in_progress', 'planned'] as const;
export type TodoResolution = (typeof TODO_RESOLUTIONS)[number];

/** Outcomes that settle the idea, hence close it; the others keep it open. */
export const CLOSING_TODO_RESOLUTIONS: readonly TodoResolution[] = ['fixed', 'declined', 'duplicate'];

/** The public note is read by the author in their own channel: short on purpose. */
export const TODO_PUBLIC_NOTE_MAX = 500;
/** Reference of the item a duplicate points to, as the bot names it. */
export const TODO_DUPLICATE_OF_RE = /^(TIM|SUG)-\d{4,6}$/;

export function parseTodoResolution(v: unknown): TodoResolution | undefined {
  return TODO_RESOLUTIONS.find((r) => r === v);
}

/** A resolution field the caller sent that breaks the closed rules above. */
export class TodoResolutionError extends Error {}

/**
 * Checks the three outcome fields as they will be stored, once merged with the
 * row. `null` clears a field. Throws `TodoResolutionError`, whose message is
 * safe to return to the caller.
 */
export function assertTodoResolutionFields(next: {
  resolution: string | null; public_note: string | null; duplicate_of: string | null;
}): void {
  if (next.resolution !== null && !parseTodoResolution(next.resolution)) {
    throw new TodoResolutionError(`resolution must be ${TODO_RESOLUTIONS.join('|')} or null`);
  }
  if (next.public_note !== null && next.public_note.length > TODO_PUBLIC_NOTE_MAX) {
    throw new TodoResolutionError(`public_note must be at most ${TODO_PUBLIC_NOTE_MAX} characters`);
  }
  if (next.duplicate_of !== null) {
    if (!TODO_DUPLICATE_OF_RE.test(next.duplicate_of)) {
      throw new TodoResolutionError('duplicate_of must look like TIM-0001 or SUG-0001');
    }
    if (next.resolution !== 'duplicate') {
      throw new TodoResolutionError('duplicate_of is only allowed with resolution "duplicate"');
    }
  }
}
