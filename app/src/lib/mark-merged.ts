/**
 * TIM-0109 — a task whose branch was merged outside Rooks (a PR merged on
 * GitHub, a merge by hand) stayed BLOCKED and held its dependents. The daemon
 * route `POST /api/tasks/:id/mark-merged` records the sha and closes it (a
 * task already done only gets the sha).
 */

const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

export function isCommitSha(value: string): boolean {
  return COMMIT_SHA_RE.test(value.trim());
}

/**
 * A blocked code or merge task, or a done one whose chain never landed
 * (`awaiting_merge`, set by the daemon: its dependents still wait).
 */
export function canMarkMerged(task: { type?: string | null; status?: string | null; awaiting_merge?: boolean | null }): boolean {
  if (task.type !== 'code' && task.type !== 'merge') return false;
  return task.status === 'BLOCKED' || (task.status === 'DONE' && task.awaiting_merge === true);
}

export type MarkMergedResult =
  | { ok: true; verified: boolean }
  | { ok: false; code: string | null; message: string | null };

export async function markTaskMerged(
  id: string,
  sha: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MarkMergedResult> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/ui/tasks/${encodeURIComponent(id)}/mark-merged`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sha: sha.trim() }),
    });
  } catch {
    return { ok: false, code: null, message: null };
  }
  const body = await res.json().catch(() => null) as { verified?: unknown; code?: unknown; error?: unknown } | null;
  if (res.ok) return { ok: true, verified: body?.verified === true };
  return {
    ok: false,
    code: typeof body?.code === 'string' ? body.code : null,
    message: typeof body?.error === 'string' ? body.error : null,
  };
}
