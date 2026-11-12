'use client';

/**
 * What a `todo.form` occupant is painted for: the creation or the edition of
 * a TO DO idea (TODO #837), the twin of `task.form`. The slot passes no props —
 * an entry is registered once and painted by every host — so the host puts
 * its idea here and the occupant reads it with `useTodoForm()`.
 *
 * The host owns the frame (`DetailFrame`: veil, focus, Escape) and the
 * daemon's calls; the occupant paints the fields and calls `submit`,
 * `handoff`, `finish`, `close`. It never talks to the daemon for them.
 *
 * Kept free of the product's form: `@rooks/ui` exports the hook on every page.
 */

import { createContext, useContext } from 'react';
import type { TodoProgress, TodoUrgency } from '@/lib/project-todo-tags';
import type { TaskAttachmentRefusal, TodoAttachment } from '@/lib/task-attachments';
import type { ProjectTodo } from './project-todo-types';

/** What `submit` sends: the whole idea, as the form holds it. */
export type TodoFormBody = {
  text: string;
  project: string | null;
  /** Markdown. */
  notes: string | null;
  urgency: TodoUrgency | null;
  progress: TodoProgress;
};

export type TodoFormSubmitResult = { ok: true; id: number } | { ok: false; error: string };
export type TodoFormHandoffResult = { ok: true; agent: string } | { ok: false; error: string };

/** An idea's files, through the host (TODO #837-E): the same gestures as a task's. */
export type TodoFormAttachments = {
  list: (todoId: number) => Promise<TodoAttachment[]>;
  upload: (todoId: number, file: File) => Promise<{ ok: true; attachment: TodoAttachment } | { ok: false; refusal: TaskAttachmentRefusal }>;
  remove: (attachment: TodoAttachment) => Promise<{ ok: true } | { ok: false; refusal: TaskAttachmentRefusal }>;
  /** Where the file is served, inline for an image or a PDF; `download` asks for a download. */
  url: (attachment: TodoAttachment, download?: boolean) => string;
};

export type TodoFormValue = {
  mode: 'create' | 'edit';
  /** The edited idea; `null` for a new one. */
  item: ProjectTodo | null;
  /** The project the screen opened the form on; the field stays editable. */
  defaultProject: string | null;
  /**
   * Creates or updates the idea and hands back its id; does not close. Files
   * dropped on a new idea are uploaded with that id, then `finish()`.
   */
  submit: (body: TodoFormBody) => Promise<TodoFormSubmitResult>;
  /** The idea's files. A change made here is read again by the screen when the form closes. */
  attachments: TodoFormAttachments;
  /**
   * Hands the idea to its project's orchestrator, who discusses it with the
   * user and files the task: the only way from an idea to a task. `null` for a
   * new idea or one without a project.
   */
  handoff: (() => Promise<TodoFormHandoffResult>) | null;
  /** The screen reads the idea again; the form stays open. */
  refresh: () => Promise<void>;
  /** The work is saved: the screen reads its ideas again and the form closes. */
  finish: () => void;
  /** Closes without saving. */
  close: () => void;
  /** Deletes the edited idea (the host confirms) and closes; `null` where the screen offers no deletion. */
  remove: (() => Promise<void>) | null;
  /** Put it on the form's heading: it names the dialog. */
  titleId: string;
};

const TodoFormContext = createContext<TodoFormValue | null>(null);

export const TodoFormProvider = TodoFormContext.Provider;

/** Readable by a plugin that takes the `todo.form` slot; `null` outside a form host. */
export function useTodoForm(): TodoFormValue | null {
  return useContext(TodoFormContext);
}
