/**
 * What the TO DO widgets show on each idea besides its title and tags: its
 * number and its author, each one a grey badge the user can hide from the
 * widget's options (edit mode). One setting per widget — "Kanban TO DO" and
 * "Project TO DO" — stored by the daemon, so every client shows the same.
 */

/** Daemon layout scope (`^[a-z0-9][a-z0-9._-]{0,63}$`). */
export const TODO_DISPLAY_SCOPE = 'project-todo.display';

export type TodoDisplay = { showId: boolean; showAuthor: boolean };
export type TodoDisplayWidget = 'all' | 'project';

/** Both shown: the number is how agents cite an idea in their reports. */
export const DEFAULT_TODO_DISPLAY: TodoDisplay = { showId: true, showAuthor: true };

type Stored = { v: 1 } & Partial<Record<TodoDisplayWidget, Partial<TodoDisplay>>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The setting of one widget; anything unreadable falls back to the default. */
export function readTodoDisplay(raw: unknown, widget: TodoDisplayWidget): TodoDisplay {
  const entry = isRecord(raw) && isRecord(raw[widget]) ? raw[widget] : {};
  return {
    showId: typeof entry.showId === 'boolean' ? entry.showId : DEFAULT_TODO_DISPLAY.showId,
    showAuthor: typeof entry.showAuthor === 'boolean' ? entry.showAuthor : DEFAULT_TODO_DISPLAY.showAuthor,
  };
}

/** The stored row with one widget's setting replaced, the other one kept. */
export function writeTodoDisplay(raw: unknown, widget: TodoDisplayWidget, next: TodoDisplay): Stored {
  const other: TodoDisplayWidget = widget === 'all' ? 'project' : 'all';
  return {
    v: 1,
    ...(isRecord(raw) && isRecord(raw[other]) ? { [other]: readTodoDisplay(raw, other) } : {}),
    [widget]: { showId: next.showId, showAuthor: next.showAuthor },
  };
}
