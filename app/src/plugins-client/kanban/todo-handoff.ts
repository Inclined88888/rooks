/**
 * Hands an idea to its project's orchestrator (`POST /api/ui/project-todo/:id/handoff`):
 * the only way from an idea to a task. Shared by the form's host and the tile's gesture.
 */

import { toast } from 'sonner';
import { apiErrorMessage } from '@/lib/api-error';
import { t } from '@/lib/i18n';
import type { TodoFormHandoffResult } from './todo-form-context';

export async function handoffTodo(id: number): Promise<TodoFormHandoffResult> {
  try {
    const res = await fetch(`/api/ui/project-todo/${id}/handoff`, { method: 'POST' });
    const json = await res.json().catch(() => ({})) as { to_agent?: unknown };
    if (!res.ok) return { ok: false, error: apiErrorMessage(json, { status: res.status }) };
    return { ok: true, agent: typeof json.to_agent === 'string' ? json.to_agent : '' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** The hand-off as a gesture of a tile: the result is told in a toast, never thrown. */
export async function handOffIdea(id: number): Promise<boolean> {
  const result = await handoffTodo(id);
  if (!result.ok) {
    toast.error(t('projectTodo.detail.handoffError'), { description: result.error });
    return false;
  }
  toast.success(t('projectTodo.detail.handoffSent', { agent: result.agent }), {
    description: t('projectTodo.detail.handoffSentHint'),
  });
  return true;
}
