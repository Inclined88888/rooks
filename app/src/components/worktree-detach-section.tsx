'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { detachTaskWorktree } from '@/lib/worktree-detach';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';

/**
 * Shown in the editor of a pending or blocked task that has a worktree
 * (TIM-0113): frees its folder without losing the branch.
 */
export function WorktreeDetachSection({ taskId, path, branch, onDetached }: {
  taskId: string;
  path: string;
  branch?: string | null;
  onDetached: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function detach() {
    if (busy || !(await confirmAction({ title: t('taskForm.detachWorktree.confirm'), confirmLabel: t('confirmDialog.detach'), destructive: true }))) return;
    setBusy(true);
    const result = await detachTaskWorktree(taskId);
    setBusy(false);
    if (result.ok) {
      toast.success(t('taskForm.detachWorktree.done'));
      onDetached();
      return;
    }
    toast.error(t('taskForm.detachWorktree.failed', { error: result.message ?? t('taskForm.markMerged.unreachable') }));
  }

  return (
    <div className="space-y-2 rounded-lg bg-muted/40 p-3">
      <div className="text-xs font-medium">{t('taskForm.detachWorktree.title')}</div>
      <p className="text-[11.5px] text-muted-foreground">
        {t('taskForm.detachWorktree.hint', { branch: branch ?? '—' })}
      </p>
      <p className="break-all text-[11px] text-muted-foreground/80">{path}</p>
      <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void detach()}>
        {busy ? t('taskForm.detachWorktree.detaching') : t('taskForm.detachWorktree.action')}
      </Button>
    </div>
  );
}
