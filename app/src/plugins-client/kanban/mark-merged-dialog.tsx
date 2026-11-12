'use client';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { MarkMergedSection } from '@/components/mark-merged-section';
import { t as i18n } from '@/lib/i18n';

/** "Merged outside Rooks?" for a DONE card, whose click opens the mission
 *  chat, not the editor (TIM-0109). */
export function MarkMergedDialog({ task, onClose, onMerged }: {
  task: { id: string; title: string };
  onClose: () => void;
  onMerged: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogTitle className="text-sm">{task.title}</DialogTitle>
        <DialogDescription className="sr-only">{i18n('taskForm.markMerged.title')}</DialogDescription>
        <MarkMergedSection taskId={task.id} done onMerged={() => { onMerged(); onClose(); }} />
      </DialogContent>
    </Dialog>
  );
}
