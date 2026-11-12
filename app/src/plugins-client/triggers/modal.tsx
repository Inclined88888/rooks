'use client';

import { toast } from 'sonner';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { copyToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

/**
 * Every window of the Triggers page is the shared Dialog: focus stays inside
 * it, Escape closes it, focus goes back to the button that opened it. A click
 * beside it does not close it — that would drop a draft, or a secret the
 * daemon hands out only once. `escapeCloses` lets a window refuse Escape too,
 * while closing it would still lose something; `onEscapeRefused` then lets it
 * say why, rather than leave a keystroke that does nothing.
 */
export function TriggerModal({ onClose, className, escapeCloses = true, onEscapeRefused, children }: {
  onClose: () => void;
  className?: string;
  escapeCloses?: boolean;
  onEscapeRefused?: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        hideClose
        aria-describedby={undefined}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (escapeCloses) return;
          event.preventDefault();
          onEscapeRefused?.();
        }}
        className={cn('flex max-h-[90vh] max-w-xl flex-col gap-0 rounded-xl border-border p-5 sm:rounded-xl', className)}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** The title Radix ties to the dialog (`aria-labelledby`). */
export function TriggerModalTitle({ children, testId }: { children: React.ReactNode; testId?: string }): React.ReactElement {
  return <DialogTitle data-testid={testId} className="text-sm font-semibold leading-normal tracking-normal">{children}</DialogTitle>;
}

/**
 * Says "copied" only once the clipboard took it, and says so when it did not:
 * a toast that lies leaves the user with nothing pasted and no reason to retry.
 */
export async function copyWithToast(value: string, copiedKey: string, failedKey = 'triggersPage.copyFailed'): Promise<boolean> {
  const ok = await copyToClipboard(value);
  if (ok) toast.success(t(copiedKey));
  else toast.error(t(failedKey));
  return ok;
}
