'use client';

/**
 * The host of every confirmation (TODO #781) and the product's dialog, the
 * default occupant of `confirm.dialog`.
 *
 * The host keeps the frame whoever paints inside: an `alertdialog` named for
 * assistive technology with the caller's own words (a replacement cannot leave
 * a question without a name), the focus held and given back, Escape and a
 * click outside answering no. It also owns the outcome: `confirm`/`cancel`
 * are bound to their question, so a late gesture from a question already
 * answered settles nothing else.
 */

import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import {
  ConfirmDialogProvider, currentConfirmQuestion, registerConfirmHost, subscribeConfirmQueue, useConfirmDialog,
  type ConfirmDialogValue, type ConfirmQuestion,
} from './confirm-dialog-context';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { CONFIRM_DIALOG_SLOT } from '@/lib/plugin-host/slots';
import { t } from '@/lib/i18n';

/** The product's confirmation: the default occupant of `confirm.dialog`. `null` outside the host. */
export function ProductConfirmDialog(): ReactElement | null {
  const question = useConfirmDialog();
  if (!question) return null;
  return (
    <>
      {/* The host names the dialog for assistive technology; this is what the eye reads. */}
      <div aria-hidden className="flex flex-col gap-1.5">
        <h2 className="m-0 text-base font-semibold leading-snug">{question.title}</h2>
        {question.description && (
          <p className="m-0 whitespace-pre-line text-sm text-muted-foreground">{question.description}</p>
        )}
      </div>
      <DialogFooter className="gap-2">
        {/* Enter right after the click that asked must not destroy anything. */}
        <Button variant="outline" data-confirm-choice="cancel" autoFocus={question.destructive} onClick={question.cancel}>
          {question.cancelLabel}
        </Button>
        <Button
          variant={question.destructive ? 'destructive' : 'default'}
          data-confirm-choice="confirm"
          autoFocus={!question.destructive}
          onClick={question.confirm}
        >
          {question.confirmLabel}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Mounted once, beside the toaster (`app/layout.tsx`). Paints the occupant of
 * `confirm.dialog` — or the product's dialog while the slot is empty (settings
 * module off, a page outside the bundled halves), so a question is never lost.
 */
export function ConfirmDialogHost(): ReactElement {
  const current = useSyncExternalStore(subscribeConfirmQueue, currentConfirmQuestion, () => undefined);
  useEffect(() => registerConfirmHost(), []);
  const claimed = useSlotEntries(CONFIRM_DIALOG_SLOT).length > 0;
  // The closing dialog keeps its last words through its exit animation; its
  // buttons no longer answer anything (`answer` settles once).
  const last = useRef<ConfirmQuestion | undefined>(undefined);
  if (current) last.current = current;
  const shown = current ?? last.current;

  const value = useMemo<ConfirmDialogValue | null>(() => {
    if (!shown) return null;
    const { request } = shown;
    const destructive = request.destructive === true;
    return {
      title: request.title,
      description: request.description?.trim() ? request.description : null,
      confirmLabel: request.confirmLabel ?? t('confirmDialog.confirm'),
      cancelLabel: request.cancelLabel ?? t('confirmDialog.cancel'),
      destructive,
      confirm: () => shown.answer(true),
      cancel: () => shown.answer(false),
    };
  }, [shown]);

  return (
    <Dialog open={current !== undefined} onOpenChange={(open) => { if (!open) current?.answer(false); }}>
      <DialogContent
        role="alertdialog"
        hideClose
        data-confirm-dialog=""
        // Above every layer of the app (menus z-80, a non-modal popover such
        // as the branch picker z-60, full-screen views z-70): a question
        // drawn under what asked it would look like a frozen click.
        overlayClassName="z-[100]"
        className="z-[100] max-w-md"
        {...(value?.description ? {} : { 'aria-describedby': undefined })}
        // The occupant focuses its own safe button (`autoFocus`); Radix must
        // not move the focus to the first one after it.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const content = event.currentTarget as HTMLElement | null;
          if (content && !content.contains(document.activeElement)) content.focus();
        }}
      >
        <DialogTitle className="sr-only">{value?.title ?? ''}</DialogTitle>
        {value?.description && <DialogDescription className="sr-only">{value.description}</DialogDescription>}
        {shown && value && (
          <ConfirmDialogProvider key={shown.id} value={value}>
            {claimed ? <SlotSingle name={CONFIRM_DIALOG_SLOT} /> : <ProductConfirmDialog />}
          </ConfirmDialogProvider>
        )}
      </DialogContent>
    </Dialog>
  );
}
