'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { isCommitSha, markTaskMerged } from '@/lib/mark-merged';

/**
 * Shown in the editor of a blocked code or merge task, and from the card of a
 * done one whose chain never landed (TIM-0109): its branch may have landed
 * outside Timon, and only the user knows the merge commit.
 */
export function MarkMergedSection({ taskId, onMerged, done = false }: {
  taskId: string;
  onMerged: () => void;
  /** The task is already DONE: only the sha is recorded (TIM-0109). */
  done?: boolean;
}) {
  const [sha, setSha] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = isCommitSha(sha);

  async function mark() {
    if (!valid || busy) return;
    setBusy(true);
    const result = await markTaskMerged(taskId, sha);
    setBusy(false);
    if (result.ok) {
      toast.success(result.verified ? t('taskForm.markMerged.done') : t('taskForm.markMerged.doneUnverified'));
      onMerged();
      return;
    }
    toast.error(result.code === 'sha_not_in_base'
      ? t('taskForm.markMerged.notInBase')
      : t('taskForm.markMerged.failed', { error: result.message ?? t('taskForm.markMerged.unreachable') }));
  }

  return (
    <div className="space-y-2 rounded-lg bg-muted/40 p-3">
      <div className="text-xs font-medium">{t('taskForm.markMerged.title')}</div>
      <p className="text-[11.5px] text-muted-foreground">{t(done ? 'taskForm.markMerged.hintDone' : 'taskForm.markMerged.hint')}</p>
      <div className="flex gap-2">
        <input
          value={sha}
          onChange={(e) => setSha(e.target.value)}
          // Enter must not submit the task form around this section.
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void mark(); } }}
          aria-label={t('taskForm.markMerged.shaLabel')}
          placeholder={t('taskForm.markMerged.shaPlaceholder')}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <Button type="button" size="sm" variant="secondary" disabled={!valid || busy} onClick={() => void mark()}>
          {busy ? t('taskForm.markMerged.marking') : t('taskForm.markMerged.action')}
        </Button>
      </div>
    </div>
  );
}
