import type { ClientRealtime } from './plugin-host/realtime';

/** Coalesce agent batches into one notebook reload per quiet window. */
export function subscribeProjectTodoChanges(realtime: ClientRealtime, reload: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = realtime.subscribe('project-todo.changed', () => {
    clearTimeout(timer);
    timer = setTimeout(reload, 150);
  });
  return () => {
    unsubscribe();
    clearTimeout(timer);
  };
}
