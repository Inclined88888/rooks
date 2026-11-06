/**
 * Files attached to a Kanban card (`attachments.ts`): list, upload, serve,
 * delete — for a task (`/api/tasks/:id/attachments`) and for an idea of the
 * TO DO notebook (`/api/project-todo/:id/attachments`), same rules.
 *
 * Every route states its authentication: 401 without an identity, 403 without
 * the Kanban permission (`kanban:write` to change, `kanban:read` or
 * `kanban:write` to read), then 404 when the card is not the viewer's — the
 * same answer as for a card that does not exist, so an id reveals nothing.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { auditRequest } from '../../users/audit-actor.js';
import { rejectIfDenied, rejectUnlessAny, requireAuth, viewerFromRequest } from '../../users/identity.js';
import { scopedDb } from '../../users/scoped-db.js';
import type { ProjectTodoRow, TaskRow } from '../../db.js';
import {
  AttachmentError, AttachmentIdSchema, AttachmentUploadSchema, attachmentHeaders, attachmentStream,
  deleteTaskAttachment, deleteTodoAttachment, getTaskAttachment, getTodoAttachment, listTodoAttachments,
  publicTaskAttachment, publicTodoAttachment, saveTaskAttachment, saveTodoAttachment, taskAttachmentsWithInherited,
  TaskIdSchema, TodoIdParamSchema, type StoredAttachment,
} from '../../attachments.js';
import { apiError } from '../../api-error.js';
// The notebook's tile shows the count: tell the client the idea moved.
import { publishTodoChanged } from './todo-api.js';

const READ_PERMISSIONS = ['kanban:read', 'kanban:write'] as const;

const TaskParams = z.object({ id: TaskIdSchema });
const TodoParams = z.object({ id: TodoIdParamSchema });
const AttachmentParams = z.object({ attachmentId: AttachmentIdSchema });

/** Auth, permission, then the task as the viewer sees it. Answers every
 *  refusal itself; returns the task when the request may go on. */
function visibleTask(req: Request, res: Response, access: 'read' | 'write'): TaskRow | null {
  if (!requireAuth(req, res)) return null;
  if (access === 'write' ? rejectIfDenied(req, res, 'kanban:write') : rejectUnlessAny(req, res, READ_PERMISSIONS)) return null;
  const params = TaskParams.safeParse({ id: req.params.id });
  if (!params.success) { res.status(400).json(apiError('task_invalid', 'Invalid task identifier.')); return null; }
  const task = scopedDb(viewerFromRequest(req)).getTask(params.data.id);
  if (!task) { res.status(404).json(apiError('task_not_found', 'Task not found.')); return null; }
  return task;
}

/** Same gate for an idea, read through the viewer's scope. */
function visibleTodo(req: Request, res: Response, access: 'read' | 'write'): ProjectTodoRow | null {
  if (!requireAuth(req, res)) return null;
  if (access === 'write' ? rejectIfDenied(req, res, 'kanban:write') : rejectUnlessAny(req, res, READ_PERMISSIONS)) return null;
  const params = TodoParams.safeParse({ id: req.params.id });
  if (!params.success) { res.status(400).json(apiError('invalid_id', 'invalid id')); return null; }
  const todo = scopedDb(viewerFromRequest(req)).getProjectTodo(params.data.id);
  if (!todo) { res.status(404).json(apiError('todo_not_found', 'project-todo item not found')); return null; }
  return todo;
}

function attachmentParams(req: Request, res: Response): string | null {
  const params = AttachmentParams.safeParse({ attachmentId: req.params.attachmentId });
  if (!params.success) { res.status(400).json(apiError('attachment_invalid', 'Invalid attachment identifier.')); return null; }
  return params.data.attachmentId;
}

function refuse(res: Response, err: unknown): void {
  if (err instanceof AttachmentError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
  console.warn(`[attachments] ${(err as Error).message}`);
  res.status(500).json(apiError('attachment_write_failed', 'The file could not be stored. Please try again.'));
}

function serve(req: Request, res: Response, found: StoredAttachment | null): void {
  if (!found) { res.status(404).json(apiError('attachment_not_found', 'Attachment not found.')); return; }
  const download = req.query.download === '1';
  res.set(attachmentHeaders(found, download));
  const stream = attachmentStream(found);
  stream.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); });
  stream.pipe(res);
}

function uploadBody(req: Request, res: Response): z.infer<typeof AttachmentUploadSchema> | null {
  const body = AttachmentUploadSchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json(apiError('attachment_invalid', 'Expected { name, data } with data in base64.'));
    return null;
  }
  return body.data;
}

export function registerAttachmentRoutes(app: Router): void {
  app.get('/api/tasks/:id/attachments', (req, res) => {
    const task = visibleTask(req, res, 'read');
    if (!task) return;
    res.json({ attachments: taskAttachmentsWithInherited(task).map(publicTaskAttachment) });
  });

  app.post('/api/tasks/:id/attachments', (req, res) => {
    const id = visibleTask(req, res, 'write')?.id;
    if (!id) return;
    const body = uploadBody(req, res);
    if (!body) return;
    try {
      const saved = saveTaskAttachment(id, body);
      auditRequest(req, 'task.attachment_add', `${id} ${saved.id}`);
      res.status(201).json({ attachment: publicTaskAttachment(saved) });
    } catch (err) {
      refuse(res, err);
    }
  });

  app.get('/api/tasks/:id/attachments/:attachmentId', (req, res) => {
    const id = visibleTask(req, res, 'read')?.id;
    if (!id) return;
    const attachmentId = attachmentParams(req, res);
    if (!attachmentId) return;
    serve(req, res, getTaskAttachment(id, attachmentId));
  });

  app.delete('/api/tasks/:id/attachments/:attachmentId', (req, res) => {
    const id = visibleTask(req, res, 'write')?.id;
    if (!id) return;
    const attachmentId = attachmentParams(req, res);
    if (!attachmentId) return;
    if (!deleteTaskAttachment(id, attachmentId)) {
      res.status(404).json(apiError('attachment_not_found', 'Attachment not found.'));
      return;
    }
    auditRequest(req, 'task.attachment_delete', `${id} ${attachmentId}`);
    res.json({ ok: true });
  });
  app.get('/api/project-todo/:id/attachments', (req, res) => {
    const todo = visibleTodo(req, res, 'read');
    if (!todo) return;
    res.json({ attachments: listTodoAttachments(todo.id).map(publicTodoAttachment) });
  });

  app.post('/api/project-todo/:id/attachments', (req, res) => {
    const todo = visibleTodo(req, res, 'write');
    if (!todo) return;
    const id = todo.id;
    const body = uploadBody(req, res);
    if (!body) return;
    try {
      const saved = saveTodoAttachment(id, body);
      auditRequest(req, 'todo.attachment_add', `${id} ${saved.id}`);
      publishTodoChanged(todo);
      res.status(201).json({ attachment: publicTodoAttachment(saved) });
    } catch (err) {
      refuse(res, err);
    }
  });

  app.get('/api/project-todo/:id/attachments/:attachmentId', (req, res) => {
    const id = visibleTodo(req, res, 'read')?.id;
    if (!id) return;
    const attachmentId = attachmentParams(req, res);
    if (!attachmentId) return;
    serve(req, res, getTodoAttachment(id, attachmentId));
  });

  app.delete('/api/project-todo/:id/attachments/:attachmentId', (req, res) => {
    const todo = visibleTodo(req, res, 'write');
    if (!todo) return;
    const id = todo.id;
    const attachmentId = attachmentParams(req, res);
    if (!attachmentId) return;
    if (!deleteTodoAttachment(id, attachmentId)) {
      res.status(404).json(apiError('attachment_not_found', 'Attachment not found.'));
      return;
    }
    auditRequest(req, 'todo.attachment_delete', `${id} ${attachmentId}`);
    publishTodoChanged(todo);
    res.json({ ok: true });
  });
}
