'use client';

import { CornerDownRight, X } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { t as i18n } from '@/lib/i18n';
import type { ComposerReply } from './message-actions';

/** How long the bubble a quote leads to stays highlighted. */
const FLASH_MS = 1600;

/**
 * Scrolls the thread to the bubble of `eventId` and flashes it. False when it
 * is not on screen — an older page of the conversation that was not loaded.
 */
export function scrollToMessage(eventId: number, root: ParentNode = document): boolean {
  const target = root.querySelector<HTMLElement>(`[data-event-id="${eventId}"]`);
  if (!target) return false;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('chat-msg-flash');
  window.setTimeout(() => target.classList.remove('chat-msg-flash'), FLASH_MS);
  return true;
}

function goTo(eventId: number): void {
  if (!scrollToMessage(eventId)) toast.info(i18n('chatPage.replyTargetNotLoaded'));
}

/** The quote at the head of a human bubble that replied to an earlier message. */
export function ReplyQuote({ reply }: { reply: { eventId: number; role: 'agent' | 'user'; excerpt: string } }) {
  const label = i18n(reply.role === 'agent' ? 'chatPage.replyToAgent' : 'chatPage.replyToSelf');
  return (
    <button
      type="button"
      onClick={() => goTo(reply.eventId)}
      title={i18n('chatPage.replyGoTo')}
      className="mb-2 flex w-full min-w-0 items-start gap-1.5 rounded-lg bg-foreground/[0.06] px-2.5 py-1.5 text-left text-[12px] leading-snug text-muted-foreground transition-colors hover:bg-foreground/[0.1]"
    >
      <CornerDownRight className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">
        <span className="block text-[10.5px] font-medium text-foreground/80">{label}</span>
        <span className="line-clamp-2">{reply.excerpt}</span>
      </span>
    </button>
  );
}

/** The strip above the input while a reply is armed: what it answers, and a cross. */
export function ReplyStrip({
  reply,
  onCancel,
  compact = false,
}: {
  reply: ComposerReply;
  onCancel: () => void;
  compact?: boolean;
}) {
  const label = i18n(reply.role === 'agent' ? 'chatPage.replyingToAgent' : 'chatPage.replyingToSelf');
  return (
    <div
      role="status"
      className={cn(
        'mb-1.5 flex min-w-0 items-center gap-2 rounded-xl bg-foreground/[0.06] pl-2.5 pr-1 text-muted-foreground',
        compact ? 'py-0.5 text-[10.5px]' : 'py-1 text-[11.5px]',
      )}
    >
      <CornerDownRight className="size-3.5 shrink-0" aria-hidden />
      <button
        type="button"
        onClick={() => goTo(reply.eventId)}
        title={i18n('chatPage.replyGoTo')}
        className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left"
      >
        <span className="shrink-0 font-medium text-foreground/80">{label}</span>
        <span className="truncate">{reply.excerpt}</span>
      </button>
      <button
        type="button"
        onClick={onCancel}
        aria-label={i18n('chatPage.replyCancel')}
        title={i18n('chatPage.replyCancel')}
        className="grid size-6 shrink-0 place-items-center rounded-full transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
