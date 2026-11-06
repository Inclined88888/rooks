'use client';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { t } from '@/lib/i18n';

/**
 * Asks before opening a file the agent linked to outside its own folder. The
 * link comes from the agent's reply, so the full path is shown: a poisoned
 * reply can name any file of the machine, and the answer is the user's.
 */
export function ExternalFileDialog({ path, onClose, onConfirm }: {
  path: string | null;
  onClose: () => void;
  onConfirm: (path: string) => void;
}) {
  return (
    <Dialog open={path !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t('fileLink.warningTitle')}</DialogTitle>
          <DialogDescription>{t('fileLink.warningBody')}</DialogDescription>
        </DialogHeader>
        <p className="break-all rounded-md bg-muted/50 px-3 py-2 text-[12.5px] text-foreground">{path}</p>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>{t('fileLink.no')}</Button>
          <Button type="button" onClick={() => { if (path) onConfirm(path); }}>{t('fileLink.yes')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
