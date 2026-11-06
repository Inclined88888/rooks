/**
 * Closed vocabulary of the TO DO notebook tags — mirror of
 * `orchestrator/src/project-todo-tags.ts` (the two packages are independent).
 * Two axes, one value each: urgency / kind, and progress.
 *
 * Tailwind classes are whole literals on purpose: the scanner cannot see a
 * class assembled from pieces.
 */
export const TODO_URGENCIES = ['critical', 'bug', 'minor', 'idea'] as const;
export const TODO_PROGRESSES = ['todo', 'analyzed', 'partial', 'to_test', 'done'] as const;

export type TodoUrgency = (typeof TODO_URGENCIES)[number];
export type TodoProgress = (typeof TODO_PROGRESSES)[number];

/** Untagged older ideas read as plain `todo`. */
export function effectiveProgress(progress: TodoProgress | null | undefined): TodoProgress {
  return progress ?? 'todo';
}

/** Chip colours, one set per tag: border + text + soft background. */
export const URGENCY_CLASS: Record<TodoUrgency, string> = {
  critical: 'border-red-500/40 bg-red-500/10 text-red-500',
  bug: 'border-orange-500/40 bg-orange-500/10 text-orange-500',
  minor: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  idea: 'border-violet-500/40 bg-violet-500/10 text-violet-400',
};
export const PROGRESS_CLASS: Record<TodoProgress, string> = {
  todo: 'border-border bg-muted/40 text-muted-foreground',
  analyzed: 'border-sky-500/40 bg-sky-500/10 text-sky-500',
  partial: 'border-blue-500/40 bg-blue-500/10 text-blue-400',
  to_test: 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-400',
  done: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
};
