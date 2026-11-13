'use client';

/**
 * The attachments another surface deposited for this conversation (TODO
 * #468): the browser panel, an image annotator. They sit above the field
 * like the user's own, and each one can be taken back before the send.
 */

import { FileText, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { fmtAttachmentSize } from '@/lib/attachments';
import { t as i18n } from '@/lib/i18n';
import {
  attachmentPreviewUrl,
  removePendingAttachments,
  type PendingAttachment,
} from '@/lib/pending-attachments';

export function PendingAttachmentRow({
  box,
  items,
}: {
  box: string;
  items: readonly PendingAttachment[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="mx-1.5 mb-1.5 flex flex-wrap gap-1.5" data-pending-attachments={box}>
      {items.map((item) => (
        <div
          key={item.id}
          data-pending-attachment={item.id}
          className="group relative flex max-w-[220px] items-center gap-2 rounded-md border border-border bg-muted/30 py-1 pl-1 pr-7"
          title={item.source ? `${item.label} · ${item.source}` : item.label}
        >
          {item.kind === 'image' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={attachmentPreviewUrl(item)}
              alt={i18n('chatPage.pendingImageAlt')}
              className="size-9 shrink-0 rounded object-cover"
            />
          ) : (
            <span className="grid size-9 shrink-0 place-items-center">
              <FileText className="size-4 text-muted-foreground" />
            </span>
          )}
          <div className="min-w-0">
            <div className="truncate text-[11.5px] leading-tight text-foreground">{item.label}</div>
            <div className="text-[10px] leading-tight tabular-nums text-muted-foreground">
              {fmtAttachmentSize(item.size)}
            </div>
          </div>
          <button
            type="button"
            onClick={() => removePendingAttachments(box, [item.id])}
            className={cn(
              'absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-full text-muted-foreground',
              'opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100',
            )}
            aria-label={i18n('chatPage.removeAttachment')}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
