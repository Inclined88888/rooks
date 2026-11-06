import type { TodoProgress, TodoUrgency } from '@/lib/project-todo-tags';

/** Where the idea lives outside Timon, written by a plugin (`todo_external_ref`). */
export type ProjectTodoLink = {
  provider: string;
  ref: string;
  /** http(s), checked by the daemon — and again before it becomes an `href`. */
  url: string | null;
  label: string | null;
  plugin_id: string | null;
  created_at: number;
};

/** Mirror of `/api/project-todo` (ProjectTodoRow on the orchestrator side). Shared by
 *  the tile and the detail modal so a field added to the schema does not drift
 *  between the two. */
export type ProjectTodo = {
  id: number;
  text: string;
  project: string | null;
  /** Agent name, or `user` from the cockpit. null = an idea older than the field. */
  author: string | null;
  /** `promoted` = the idea became a task; it is never set by hand. */
  status: 'open' | 'done' | 'promoted';
  /** Long description, in markdown. */
  notes: string | null;
  created_at: number;
  updated_at: number;
  done_at: number | null;
  /** Task born from the idea, null if never promoted. Answers "where does this task come from?". */
  promoted_task_id: string | null;
  /** Urgency / nature tag, null = unclassified. */
  urgency: TodoUrgency | null;
  /** Progress tag, null = older than the tags (counts as `todo`). */
  progress: TodoProgress | null;
  /** Absent from an older daemon. */
  links?: ProjectTodoLink[];
  /** Files attached to the idea; absent from a daemon older than the attachments. */
  attachment_count?: number;
};
