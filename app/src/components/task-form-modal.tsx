'use client';

/**
 * The task form's host: what the Kanban board, the Agents page and the agents
 * grid open to create or edit a task.
 *
 * It paints the occupant of the `task.form` slot (`docs/PLUGINS.md`,
 * section `Remplacer la popup de task`) — the product's form while no plugin took
 * the slot — and keeps what a replacement must not be able to break: the
 * modal frame, the focus held inside it and given back on close, Escape, and
 * the daemon's calls (`useTaskForm()`).
 */

import { useCallback, useId, useMemo, useRef, type ReactElement } from 'react';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { TASK_FORM_SLOT } from '@/lib/plugin-host/slots';
import { DetailFrame } from '@/components/detail-frame';
import {
  deleteTaskAttachment, listTaskAttachments, taskAttachmentUrl, uploadTaskAttachment,
} from '@/lib/task-attachments';
import { ProductTaskForm } from '@/components/task-form/task-form';
import {
  TaskFormProvider, type TaskFormAgent, type TaskFormAttachments, type TaskFormSubmitResult, type TaskFormValue,
} from '@/components/task-form/task-form-context';
import type { TaskFormBody, TaskFormSource } from '@/components/task-form/task-form-model';

export type { TaskFormSource, TaskStatus, TaskType } from '@/components/task-form/task-form-model';
import { apiErrorMessage } from '@/lib/api-error';

export type TaskFormModalProps = {
  task?: TaskFormSource | null;
  defaultAgent?: string;
  /** Agents already in hand (a name at least); the form reads the full list itself. */
  agents?: TaskFormAgent[];
  onSaved?: () => void;
  /** Deletes the task, confirmation included; resolves `true` once it is gone. */
  onDelete?: () => Promise<boolean>;
  onClose: () => void;
};

const ATTACHMENTS: TaskFormAttachments = {
  list: listTaskAttachments,
  upload: uploadTaskAttachment,
  remove: deleteTaskAttachment,
  url: taskAttachmentUrl,
};

/** The daemon's error text, or the status when it sent none. */
async function errorOf(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: unknown } | null;
  return apiErrorMessage(body, { status: res.status });
}

async function submitTask(task: TaskFormSource | null, body: TaskFormBody): Promise<TaskFormSubmitResult> {
  // `scheduled_at: null` keeps a stored date on purpose (a client sending its
  // whole form back must not unschedule by accident): clearing one is asked for.
  const sent: Record<string, unknown> = task && body.scheduled_at === null && task.scheduled_at
    ? { ...body, clear_scheduled_at: true }
    : { ...body };
  if (task) delete sent.pipeline;
  try {
    const res = await fetch(task ? `/api/ui/tasks/${encodeURIComponent(task.id)}` : '/api/ui/tasks', {
      method: task ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sent),
    });
    if (!res.ok) return { ok: false, error: await errorOf(res) };
    const json = await res.json().catch(() => null) as { id?: unknown; task?: { id?: unknown } } | null;
    const id = typeof json?.task?.id === 'string' ? json.task.id : typeof json?.id === 'string' ? json.id : task?.id;
    return id ? { ok: true, id } : { ok: false, error: 'no task id in the answer' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function TaskFormModal({ task, defaultAgent, agents, onSaved, onDelete, onClose }: TaskFormModalProps): ReactElement {
  const titleId = useId();
  const latest = useRef({ onSaved, onDelete, onClose });
  latest.current = { onSaved, onDelete, onClose };

  const close = useCallback(() => { latest.current.onClose(); }, []);
  const finish = useCallback(() => {
    latest.current.onSaved?.();
    latest.current.onClose();
  }, []);

  const value = useMemo<TaskFormValue>(() => ({
    mode: task ? 'edit' : 'create',
    task: task ?? null,
    defaultAgent: defaultAgent ?? null,
    agents: agents ?? [],
    submit: (body) => submitTask(task ?? null, body),
    attachments: ATTACHMENTS,
    finish,
    close,
    remove: task && onDelete
      ? async () => { if (await latest.current.onDelete?.()) latest.current.onClose(); }
      : null,
    titleId,
  }), [task, defaultAgent, agents, finish, close, titleId, onDelete]);

  const claimed = useSlotEntries(TASK_FORM_SLOT).length > 0;
  return (
    <DetailFrame labelledBy={titleId} onClose={close}>
      <TaskFormProvider value={value}>
        {claimed ? <SlotSingle name={TASK_FORM_SLOT} /> : <ProductTaskForm />}
      </TaskFormProvider>
    </DetailFrame>
  );
}
