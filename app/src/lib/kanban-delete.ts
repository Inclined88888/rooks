import { t } from './i18n';

const conflictKeys: Readonly<Record<string, string>> = {
  task_state: 'kanbanDelete.state',
  task_dependents: 'kanbanDelete.dependents',
  task_chain: 'kanbanDelete.chain',
  task_mission: 'kanbanDelete.mission',
  task_worktree: 'kanbanDelete.worktree',
  task_pipeline: 'kanbanDelete.pipeline',
};

type Blocker = { id: string; title: string };

function readBlockers(raw: unknown): Blocker[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((b: unknown) => {
    if (!b || typeof b !== 'object') return [];
    const { id, title } = b as Record<string, unknown>;
    return typeof id === 'string' ? [{ id, title: typeof title === 'string' ? title : '' }] : [];
  });
}

export type KanbanDeleteResult = {
  ok: boolean;
  message: string;
  /** Set when the task heads a verification chain: how many tasks deleting the
   *  whole chain removes, root included. The caller confirms, then retries with `chain`. */
  chainSize?: number;
};

export async function deleteKanbanTask(id: string, opts: { chain?: boolean } = {}): Promise<KanbanDeleteResult> {
  try {
    const query = opts.chain ? '?chain=1' : '';
    const response = await fetch(`/api/ui/tasks/${encodeURIComponent(id)}${query}`, { method: 'DELETE' });
    const body: unknown = await response.json().catch(() => null);
    const field = (name: string): unknown =>
      body && typeof body === 'object' && name in body ? (body as Record<string, unknown>)[name] : undefined;
    if (response.ok) {
      const deleted = field('deleted');
      const count = Array.isArray(deleted) ? deleted.length : 1;
      return { ok: true, message: count > 1 ? t('kanbanDelete.chainSuccess', { count }) : t('kanbanDelete.success') };
    }
    const code = typeof field('code') === 'string' ? field('code') as string : '';
    let key = 'kanbanDelete.failed';
    if (response.status === 401) key = 'kanbanDelete.unauthorized';
    else if (response.status === 403) key = 'kanbanDelete.forbidden';
    else if (response.status === 404) key = 'kanbanDelete.notFound';
    else if (response.status === 409 && Object.hasOwn(conflictKeys, code)) key = conflictKeys[code]!;
    if (response.status !== 409) return { ok: false, message: t(key) };

    const chainSize = typeof field('chain_size') === 'number' ? field('chain_size') as number : undefined;
    let message = t(key, { count: chainSize ?? 0 });
    // A chain deletion can be held back by another member than the one clicked.
    const at = field('task_id');
    if (typeof at === 'string' && at !== id) message = t('kanbanDelete.chainMember', { id: at.slice(0, 8), reason: message });
    const blockers = readBlockers(field('blockers'));
    if (blockers.length > 0 && code !== 'task_chain') {
      const list = blockers.slice(0, 5).map((b) => `#${b.id.slice(0, 8)}${b.title ? ` ${b.title}` : ''}`).join(', ');
      message += ` ${t('kanbanDelete.blockers', { list: blockers.length > 5 ? `${list}, +${blockers.length - 5}` : list })}`;
    }
    const hidden = field('hidden_blockers');
    if (typeof hidden === 'number' && hidden > 0) message += ` ${t('kanbanDelete.hiddenBlockers', { count: hidden })}`;
    return { ok: false, message, ...(code === 'task_chain' && chainSize ? { chainSize } : {}) };
  } catch {
    return { ok: false, message: t('kanbanDelete.network') };
  }
}
