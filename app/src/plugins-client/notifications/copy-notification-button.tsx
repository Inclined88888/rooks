'use client';

import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { copyToClipboard } from '@/lib/clipboard';

/** What lands on the clipboard: the whole text, never the clamped one. */
export function notificationCopyText(n: { title: string; body: string | null }): string {
  return n.body ? `${n.title}\n\n${n.body}` : n.title;
}

/**
 * "Copy" on a notification, for an error text to paste elsewhere. Cards are
 * wrapped in the mission link, so the click must neither follow it nor start
 * a drag, like the dismiss button beside it.
 */
export function CopyNotificationButton({ notification, className }: {
  notification: { title: string; body: string | null };
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (await copyToClipboard(notificationCopyText(notification))) toast.success(t('notifications.copied'));
        else toast.error(t('notifications.copyFailed'));
      }}
      aria-label={t('notifications.copy')}
      title={t('notifications.copy')}
      className={cn(
        'grid shrink-0 place-items-center rounded text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <Copy className="size-3" aria-hidden="true" />
    </button>
  );
}
