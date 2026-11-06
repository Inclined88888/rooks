'use client';

/**
 * What a `task.form` occupant is painted for: the creation or edition of one
 * Kanban task, opened from the board, the Agents page or the agents grid.
 *
 * The slot passes no props — an entry is registered once and painted by every
 * host — so each host (`TaskFormModal`) puts its own value here and the
 * occupant reads it with `useTaskForm()`. The host owns the daemon's calls:
 * `submit` creates or updates the task, the attachment gestures upload, list
 * and remove its files; the occupant paints the fields and calls these.
 */

import { createContext, useContext } from 'react';
import type { TaskAttachment, TaskAttachmentRefusal } from '@/lib/task-attachments';
import type { TaskFormBody, TaskFormSource } from './task-form-model';

/** An agent the task may be given to, as the screen knows it (a name at least). */
export type TaskFormAgent = {
  name: string;
  project?: string | null;
  role?: string | null;
  emoji?: string | null;
  color?: string | null;
  icon_url?: string | null;
  /** What the agent runs on when nothing else decides: the "inherited" model. */
  backend?: string | null;
  model?: string | null;
};

export type TaskFormSubmitResult = { ok: true; id: string } | { ok: false; error: string };

export type TaskFormAttachments = {
  list: (taskId: string) => Promise<TaskAttachment[]>;
  upload: (taskId: string, file: File) => Promise<{ ok: true; attachment: TaskAttachment } | { ok: false; refusal: TaskAttachmentRefusal }>;
  remove: (attachment: TaskAttachment) => Promise<{ ok: true } | { ok: false; refusal: TaskAttachmentRefusal }>;
  /** Where the file is served, inline for an image or a PDF; `download` asks for a download. */
  url: (attachment: TaskAttachment, download?: boolean) => string;
};

export type TaskFormValue = {
  /** `create`: a new task. `edit`: `task` is the one being changed. */
  mode: 'create' | 'edit';
  task: TaskFormSource | null;
  /** The agent a new task goes to unless the person picks another. */
  defaultAgent: string | null;
  /** The agents the screen already holds; the form may read the full list itself. */
  agents: readonly TaskFormAgent[];
  /**
   * Creates (`POST`) or updates (`PUT`) the task and hands back its id. On an
   * edited task, `scheduled_at: null` clears a date it had. Does not close:
   * files dropped before the task existed are uploaded with the id, then
   * `finish()`.
   */
  submit: (body: TaskFormBody) => Promise<TaskFormSubmitResult>;
  attachments: TaskFormAttachments;
  /** The work is saved: the screen re-reads its tasks and the form closes. */
  finish: () => void;
  /** Closes without saving anything. */
  close: () => void;
  /**
   * Deletes the edited task (the host asks for confirmation) and closes once
   * it is gone; `null` where the screen offers no deletion.
   */
  remove: (() => Promise<void>) | null;
  /** Put it on the form's heading: it names the dialog the host frames. */
  titleId: string;
};

const TaskFormContext = createContext<TaskFormValue | null>(null);

export const TaskFormProvider = TaskFormContext.Provider;

/** Readable by a plugin that takes the `task.form` slot; `null` outside a host. */
export function useTaskForm(): TaskFormValue | null {
  return useContext(TaskFormContext);
}
