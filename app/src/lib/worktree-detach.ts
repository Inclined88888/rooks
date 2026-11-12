/**
 * TIM-0113 — detaching a task from its worktree: the daemon route
 * `POST /api/tasks/:id/worktree/detach` removes the folder and keeps the
 * branch with its commits; the next dispatch reattaches to it.
 */

/** A task that has a worktree and is not running in it. */
export function canDetachWorktree(task: { status?: string | null; worktree_path?: string | null }): boolean {
  return !!task.worktree_path && (task.status === 'PENDING' || task.status === 'BLOCKED');
}

export type DetachResult = { ok: true } | { ok: false; message: string | null };

export async function detachTaskWorktree(id: string, fetchImpl: typeof fetch = fetch): Promise<DetachResult> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/ui/tasks/${encodeURIComponent(id)}/worktree-detach`, { method: 'POST' });
  } catch {
    return { ok: false, message: null };
  }
  if (res.ok) return { ok: true };
  const body = await res.json().catch(() => null) as { error?: unknown } | null;
  return { ok: false, message: typeof body?.error === 'string' ? body.error : null };
}
