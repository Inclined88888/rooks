/**
 * The attached files of a Kanban task or of a TO DO idea, seen from the app
 * (`docs/TASK-ATTACHMENTS.md`). One mechanism for both owners, as on the
 * daemon: only the URL changes (`/api/ui/tasks/<id>/…`,
 * `/api/ui/project-todo/<id>/…`).
 *
 * The daemon owns every rule — size, count, accepted types, the file's real
 * signature — and refuses with a `{ error, code }`. The bounds below are only
 * a copy, read before a file is sent so that a 40 MB video is refused at once
 * instead of after its upload: the daemon's answer stays the authority.
 */

import { bytesToBase64 } from '@/lib/native-browser-input';
import { apiErrorMessage } from '@/lib/api-error';
import { t } from '@/lib/i18n';

/** What every stored file has, whoever owns it: all the attachments field reads. */
export type StoredAttachment = {
  id: string;
  name: string;
  size: number;
  mime: string;
  kind: 'image' | 'document';
  created_at: number;
};

export type TaskAttachment = StoredAttachment & {
  /** The task that owns the file: an iteration inherits its root's, served under the root. */
  task_id: string;
};

export type TodoAttachment = StoredAttachment & {
  /** The TO DO idea that owns the file. */
  todo_id: number;
};

/** Copies of `orchestrator/src/attachments.ts`; the daemon re-checks them all. */
export const MAX_TASK_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const MAX_TASK_ATTACHMENTS = 20;
export const MAX_TASK_ATTACHMENTS_TOTAL_BYTES = 100 * 1024 * 1024;
export const TASK_ATTACHMENT_EXTENSIONS: readonly string[] = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'md', 'csv', 'tsv', 'json', 'yaml', 'yml', 'log', 'rtf',
  'xml', 'toml', 'ini', 'css', 'js', 'cjs', 'mjs', 'ts', 'py',
  'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'doc', 'xls', 'ppt',
];
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** The `accept` of a file input: the extensions the daemon takes. */
export const TASK_ATTACHMENT_ACCEPT = TASK_ATTACHMENT_EXTENSIONS.map((ext) => `.${ext}`).join(',');

const taskBase = (taskId: string) => `/api/ui/tasks/${encodeURIComponent(taskId)}/attachments`;
const todoBase = (todoId: number) => `/api/ui/project-todo/${encodeURIComponent(String(todoId))}/attachments`;

/** Why a file was not attached; `message` is the daemon's text when it answered. */
export type TaskAttachmentRefusal = {
  code: 'attachment_too_large' | 'attachment_quota' | 'attachment_type_refused' | 'attachment_failed' | string;
  message: string | null;
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function isImageName(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

/**
 * What the daemon would refuse anyway, read before the bytes travel. `held` is
 * what the task already holds (files queued for upload included).
 */
export function precheckTaskAttachment(
  file: { name: string; size: number },
  held: { count: number; bytes: number },
): TaskAttachmentRefusal | null {
  if (!TASK_ATTACHMENT_EXTENSIONS.includes(extensionOf(file.name))) return { code: 'attachment_type_refused', message: null };
  if (file.size > MAX_TASK_ATTACHMENT_BYTES) return { code: 'attachment_too_large', message: null };
  if (held.count >= MAX_TASK_ATTACHMENTS || held.bytes + file.size > MAX_TASK_ATTACHMENTS_TOTAL_BYTES) {
    return { code: 'attachment_quota', message: null };
  }
  return null;
}

/** Where a file is served: inline for an image or a PDF (thumbnails, the enlarged view). */
export function taskAttachmentUrl(att: Pick<TaskAttachment, 'id' | 'task_id'>, download = false): string {
  const base = `${taskBase(att.task_id)}/${encodeURIComponent(att.id)}`;
  return download ? `${base}?download=1` : base;
}

/** A 413 or a 415 without the daemon's code (a body parser, a proxy) still says what it means. */
function codeOfStatus(status: number): string {
  if (status === 413) return 'attachment_too_large';
  if (status === 415) return 'attachment_type_refused';
  return 'attachment_failed';
}

async function refusalOf(res: Response): Promise<TaskAttachmentRefusal> {
  const body = await res.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
  return {
    code: typeof body?.code === 'string' ? body.code : codeOfStatus(res.status),
    message: apiErrorMessage(body, { status: res.status }),
  };
}

/**
 * The sentence a refusal is shown with, always from the interface's
 * messages: the daemon's own text (`message`) is English, and a stack or an
 * HTML error page must never reach the screen. `owner` picks the quota's
 * wording, which names what is full.
 */
export function attachmentRefusalText(name: string, refusal: TaskAttachmentRefusal, owner: 'task' | 'todo'): string {
  if (refusal.code === 'attachment_too_large') return t('taskForm.attachments.tooLarge', { name });
  if (refusal.code === 'attachment_type_refused' || refusal.code === 'attachment_content_mismatch') {
    return t('taskForm.attachments.typeRefused', { name });
  }
  if (refusal.code === 'attachment_quota') {
    return owner === 'todo' ? t('projectTodo.attachments.quota', { name }) : t('taskForm.attachments.quota', { name });
  }
  return t('taskForm.attachments.sendFailed', { name });
}

async function listAt<A>(base: string): Promise<A[]> {
  const res = await fetch(base, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json() as { attachments?: A[] };
  return Array.isArray(body.attachments) ? body.attachments : [];
}

async function uploadAt<A>(
  base: string,
  file: File,
): Promise<{ ok: true; attachment: A } | { ok: false; refusal: TaskAttachmentRefusal }> {
  try {
    const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: file.name, data, ...(file.type ? { mime: file.type } : {}) }),
    });
    if (!res.ok) return { ok: false, refusal: await refusalOf(res) };
    const body = await res.json() as { attachment: A };
    return { ok: true, attachment: body.attachment };
  } catch (err) {
    return { ok: false, refusal: { code: 'attachment_failed', message: (err as Error).message } };
  }
}

async function deleteAt(url: string): Promise<{ ok: true } | { ok: false; refusal: TaskAttachmentRefusal }> {
  try {
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) return { ok: false, refusal: await refusalOf(res) };
    return { ok: true };
  } catch (err) {
    return { ok: false, refusal: { code: 'attachment_failed', message: (err as Error).message } };
  }
}

export function listTaskAttachments(taskId: string): Promise<TaskAttachment[]> {
  return listAt<TaskAttachment>(taskBase(taskId));
}

export function uploadTaskAttachment(
  taskId: string,
  file: File,
): Promise<{ ok: true; attachment: TaskAttachment } | { ok: false; refusal: TaskAttachmentRefusal }> {
  return uploadAt<TaskAttachment>(taskBase(taskId), file);
}

export function deleteTaskAttachment(
  att: Pick<TaskAttachment, 'id' | 'task_id'>,
): Promise<{ ok: true } | { ok: false; refusal: TaskAttachmentRefusal }> {
  return deleteAt(taskAttachmentUrl(att));
}

/** Where an idea's file is served: inline for an image or a PDF, like a task's. */
export function todoAttachmentUrl(att: Pick<TodoAttachment, 'id' | 'todo_id'>, download = false): string {
  const base = `${todoBase(att.todo_id)}/${encodeURIComponent(att.id)}`;
  return download ? `${base}?download=1` : base;
}

export function listTodoAttachments(todoId: number): Promise<TodoAttachment[]> {
  return listAt<TodoAttachment>(todoBase(todoId));
}

export function uploadTodoAttachment(
  todoId: number,
  file: File,
): Promise<{ ok: true; attachment: TodoAttachment } | { ok: false; refusal: TaskAttachmentRefusal }> {
  return uploadAt<TodoAttachment>(todoBase(todoId), file);
}

export function deleteTodoAttachment(
  att: Pick<TodoAttachment, 'id' | 'todo_id'>,
): Promise<{ ok: true } | { ok: false; refusal: TaskAttachmentRefusal }> {
  return deleteAt(todoAttachmentUrl(att));
}
