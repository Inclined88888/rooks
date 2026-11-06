'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/intl';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';

export type AgentTrashEntry = {
  id: string;
  name: string;
  deleted_at: number;
  deleted_by: string | null;
  expires_at: number | null;
};

type TrashState = { enabled: boolean; retention_days: number; entries: AgentTrashEntry[] };

function when(ms: number): string {
  return formatDateTime(ms, { dateStyle: 'medium', timeStyle: 'short' });
}

async function errorOf(r: Response): Promise<string> {
  const body = await r.json().catch(() => ({})) as { error?: string; reason?: string };
  return body.reason ?? body.error ?? String(r.status);
}

/**
 * Deleted agents (TODO #476), grafted in Settings › System › Backups & trash
 * below the trash settings. Restore is open to `agents:manage`; deleting for
 * good is refused by the daemon to anything but a person.
 */
export function AgentTrashPanel() {
  const [state, setState] = useState<TrashState | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/ui/agent-trash', { cache: 'no-store' });
      if (!r.ok) throw new Error(await errorOf(r));
      setState(await r.json() as TrashState);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function act(entry: AgentTrashEntry, kind: 'restore' | 'purge') {
    if (kind === 'purge' && !(await confirmAction({ title: t('agentTrash.purgeConfirm', { name: entry.name }), confirmLabel: t('confirmDialog.delete'), destructive: true }))) return;
    setBusy(entry.id);
    try {
      const path = `/api/ui/agent-trash/${encodeURIComponent(entry.id)}`;
      const r = kind === 'restore' ? await fetch(`${path}/restore`, { method: 'POST' }) : await fetch(path, { method: 'DELETE' });
      if (!r.ok) throw new Error(await errorOf(r));
      toast.success(t(kind === 'restore' ? 'agentTrash.restored' : 'agentTrash.purged', { name: entry.name }));
    } catch (e) {
      toast.error(t('agentTrash.actionError', { error: (e as Error).message }));
    } finally {
      setBusy(null);
      await load();
    }
  }

  const policy = !state ? null
    : !state.enabled ? t('agentTrash.off')
      : state.retention_days > 0 ? t('agentTrash.keptDays', { days: state.retention_days }) : t('agentTrash.keptForever');

  return (
    <section className="space-y-3 py-4" aria-label={t('agentTrash.title')} aria-busy={busy !== null}>
      <h3 className="text-[13px] font-medium">{t('agentTrash.title')}</h3>
      <p className="max-w-[65ch] text-xs text-muted-foreground">
        {t('agentTrash.help')}{policy ? ` ${policy}` : ''}
      </p>
      {failed ? (
        <p role="alert" className="text-xs">{t('agentTrash.loadError')}</p>
      ) : !state ? (
        <p className="text-xs text-muted-foreground">{t('agentTrash.loading')}</p>
      ) : state.entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('agentTrash.empty')}</p>
      ) : (
        <ul className="max-w-2xl space-y-1">
          {state.entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 hover:bg-foreground/[0.04]">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{entry.name}</div>
                <div className="text-xs tabular-nums text-muted-foreground">
                  {entry.deleted_by
                    ? t('agentTrash.deletedBy', { when: when(entry.deleted_at), who: entry.deleted_by })
                    : t('agentTrash.deletedAt', { when: when(entry.deleted_at) })}
                  {entry.expires_at ? ` · ${t('agentTrash.expires', { when: when(entry.expires_at) })}` : ''}
                </div>
              </div>
              <Button variant="outline" size="sm" disabled={busy !== null}
                aria-label={t('agentTrash.restoreLabel', { name: entry.name })}
                onClick={() => void act(entry, 'restore')}>
                {t('agentTrash.restore')}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy !== null}
                aria-label={t('agentTrash.purgeLabel', { name: entry.name })}
                onClick={() => void act(entry, 'purge')}>
                {t('agentTrash.purge')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
