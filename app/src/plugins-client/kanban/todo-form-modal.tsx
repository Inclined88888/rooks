'use client';

/**
 * The TO DO idea form's host: what the Kanban column and the TO DO widgets
 * open to create or edit an idea (TODO #837), the twin of `TaskFormModal`.
 *
 * It paints the occupant of the `todo.form` slot (`docs/PLUGINS.md`,
 * `Cartes et popups du Kanban`) and keeps what a replacement must not be
 * able to break: the modal frame (`DetailFrame`) and the daemon's calls
 * (`useTodoForm()`).
 */

import { useCallback, useId, useMemo, useRef, type ReactElement } from 'react';
import { DetailFrame } from '@/components/detail-frame';
import { apiErrorMessage } from '@/lib/api-error';
import { effectiveProgress } from '@/lib/project-todo-tags';
import {
  deleteTodoAttachment, listTodoAttachments, todoAttachmentUrl, uploadTodoAttachment,
} from '@/lib/task-attachments';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { TODO_FORM_SLOT } from '@/lib/plugin-host/slots';
import { ProductTodoForm } from './product-todo-form';
import {
  TodoFormProvider, type TodoFormAttachments, type TodoFormBody, type TodoFormSubmitResult, type TodoFormValue,
} from './todo-form-context';
import { handoffTodo } from './todo-handoff';
import type { ProjectTodo } from './project-todo-types';

export type TodoFormModalProps = {
  /** The edited idea; absent for a new one. */
  item?: ProjectTodo | null;
  /** The project a new idea is filed under, still editable. */
  defaultProject?: string | null;
  /** The screen reads its ideas again. */
  onSaved?: () => void | Promise<void>;
  /** Deletes the idea, confirmation included; resolves `true` once it is gone. */
  onDelete?: () => Promise<boolean>;
  onClose: () => void;
};

async function errorOf(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: unknown } | null;
  return apiErrorMessage(body, { status: res.status });
}

async function submitTodo(item: ProjectTodo | null, body: TodoFormBody): Promise<TodoFormSubmitResult> {
  // A progress sent with an edit also moves the done checkbox: only when it changed.
  const sent: Partial<TodoFormBody> = item && body.progress === effectiveProgress(item.progress)
    ? { text: body.text, project: body.project, notes: body.notes, urgency: body.urgency }
    : { ...body };
  try {
    const res = await fetch(item ? `/api/ui/project-todo/${item.id}` : '/api/ui/project-todo', {
      method: item ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sent),
    });
    if (!res.ok) return { ok: false, error: await errorOf(res) };
    const json = await res.json().catch(() => null) as { id?: unknown; item?: { id?: unknown } } | null;
    const id = typeof json?.item?.id === 'number' ? json.item.id : typeof json?.id === 'number' ? json.id : item?.id;
    return typeof id === 'number' ? { ok: true, id } : { ok: false, error: 'no idea id in the answer' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function TodoFormModal({ item, defaultProject, onSaved, onDelete, onClose }: TodoFormModalProps): ReactElement {
  const titleId = useId();
  const latest = useRef({ onSaved, onDelete, onClose });
  latest.current = { onSaved, onDelete, onClose };

  // An added or removed file changes the tile's 📎 count; the screen reads the
  // ideas again when the form closes, not on each file, which would reset the
  // drafts of an edition in progress.
  const filesChanged = useRef(false);
  const attachments = useMemo<TodoFormAttachments>(() => ({
    list: listTodoAttachments,
    upload: async (todoId, file) => {
      const r = await uploadTodoAttachment(todoId, file);
      if (r.ok) filesChanged.current = true;
      return r;
    },
    remove: async (attachment) => {
      const r = await deleteTodoAttachment(attachment);
      if (r.ok) filesChanged.current = true;
      return r;
    },
    url: todoAttachmentUrl,
  }), []);

  const close = useCallback(() => {
    if (filesChanged.current) void latest.current.onSaved?.();
    latest.current.onClose();
  }, []);
  const refresh = useCallback(async () => { await latest.current.onSaved?.(); }, []);
  const finish = useCallback(() => {
    void latest.current.onSaved?.();
    latest.current.onClose();
  }, []);

  const value = useMemo<TodoFormValue>(() => ({
    mode: item ? 'edit' : 'create',
    item: item ?? null,
    defaultProject: item ? item.project : defaultProject ?? null,
    submit: (body) => submitTodo(item ?? null, body),
    attachments,
    handoff: item?.project ? () => handoffTodo(item.id) : null,
    refresh,
    finish,
    close,
    remove: item && onDelete
      ? async () => { if (await latest.current.onDelete?.()) latest.current.onClose(); }
      : null,
    titleId,
  }), [item, defaultProject, attachments, refresh, finish, close, titleId, onDelete]);

  // The product's form is painted directly while only the registered
  // fallback holds the slot: that one is loaded on demand, and the frame would
  // stay empty while its chunk arrives.
  const occupant = useSlotEntries(TODO_FORM_SLOT)[0];
  return (
    <DetailFrame labelledBy={titleId} onClose={close}>
      <TodoFormProvider value={value}>
        {occupant && !occupant.fallback ? <SlotSingle name={TODO_FORM_SLOT} /> : <ProductTodoForm />}
      </TodoFormProvider>
    </DetailFrame>
  );
}
