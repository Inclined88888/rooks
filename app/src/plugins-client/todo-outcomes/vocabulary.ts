/**
 * Outcome given to an idea — mirror of `orchestrator/src/plugins-bundled/todo-outcomes/vocabulary.ts`.
 * Each change is announced outside Rooks (`todo_resolved`, e.g. to the author
 * in the channel the idea came from) together with the public note.
 */
export const TODO_RESOLUTIONS = ['fixed', 'declined', 'duplicate', 'needs_info', 'in_progress', 'planned'] as const;
export type TodoResolution = (typeof TODO_RESOLUTIONS)[number];
/** Outcomes that settle the idea, so the daemon closes it. */
export const CLOSING_TODO_RESOLUTIONS: readonly TodoResolution[] = ['fixed', 'declined', 'duplicate'];
export const TODO_PUBLIC_NOTE_MAX = 500;
export const TODO_DUPLICATE_OF_RE = /^(TIM|SUG)-\d{4,6}$/;

export const RESOLUTION_CLASS: Record<TodoResolution, string> = {
  fixed: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  declined: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-400',
  duplicate: 'border-slate-500/40 bg-slate-500/10 text-slate-400',
  needs_info: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  in_progress: 'border-blue-500/40 bg-blue-500/10 text-blue-400',
  planned: 'border-sky-500/40 bg-sky-500/10 text-sky-500',
};
