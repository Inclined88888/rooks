'use client';

/**
 * The PWA's annotation bubble (TODO #481): the same gesture as the desktop's, drawn in HTML over
 * the page's picture (`browser.surface`). Click an element, type, Enter adds it to the queue and
 * leaves a numbered pin, Shift+Enter breaks the line, Escape cancels, "Send" posts the queue as
 * one message of the conversation.
 *
 * What is typed here is Rooks's, never the page's: the remote surface ignores any key or press
 * whose target is in a layer, and the bubble stops them itself as well (defence in depth).
 */

import { useEffect, useLayoutEffect, useRef, useState, type SyntheticEvent } from 'react';
import { Loader2, Send, Trash2, X } from 'lucide-react';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type SurfaceRect = { left: number; top: number; width: number; height: number };

const BUBBLE_WIDTH = 288;
const GAP = 8;

/** Below the element, above it without room, always inside the surface. */
export function bubblePlace(anchor: SurfaceRect | null, box: { width: number; height: number }, height: number): { left: number; top: number } {
  const width = Math.min(BUBBLE_WIDTH, Math.max(0, box.width - 2 * GAP));
  const clampX = (x: number) => Math.max(GAP, Math.min(x, box.width - width - GAP));
  if (!anchor) return { left: clampX((box.width - width) / 2), top: GAP };
  const below = anchor.top + anchor.height + GAP;
  const above = anchor.top - GAP - height;
  const top = below + height <= box.height - GAP || above < GAP ? below : above;
  return { left: clampX(anchor.left), top: Math.max(GAP, Math.min(top, box.height - height - GAP)) };
}

/** Keys, presses and wheels in the bubble stay in the bubble. */
const keep = (event: SyntheticEvent) => { event.stopPropagation(); };

export type AnnotationBubbleProps = {
  mode: 'new' | 'edit';
  /** Its number in the queue, the one its pin shows. */
  number: number;
  /** The element, as the page named it: shown as text. */
  label: string;
  initial: string;
  anchor: SurfaceRect | null;
  box: { width: number; height: number };
  /** The annotations already queued; "Send" counts the one being typed too. */
  queued: number;
  canSend: boolean;
  busy: boolean;
  error: string | null;
  onDraft(text: string): void;
  onAdd(text: string): void;
  onSend(text: string): void;
  onCancel(): void;
  onDelete(): void;
};

export function AnnotationBubble(props: AnnotationBubbleProps) {
  const { mode, number, label, initial, anchor, box, queued, canSend, busy, error } = props;
  const [text, setText] = useState(initial);
  const [height, setHeight] = useState(150);
  const frame = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setText(initial); }, [initial, number, mode]);
  useEffect(() => { field.current?.focus(); }, [number, mode]);
  useLayoutEffect(() => {
    const measured = frame.current?.offsetHeight;
    if (measured && measured !== height) setHeight(measured);
  });
  const place = bubblePlace(anchor, box, height);
  const typed = text.trim().length > 0;
  const sendCount = queued + (mode === 'new' && typed ? 1 : 0);
  const change = (value: string) => { setText(value); props.onDraft(value); };

  return (
    <div
      ref={frame}
      role="dialog"
      aria-label={t('browserPanel.annotations.bubble.label', { n: number })}
      data-annotation-bubble={mode}
      className="pointer-events-auto absolute z-10 flex flex-col gap-2 rounded-xl bg-popover p-2.5 text-popover-foreground shadow-xl"
      style={{ left: place.left, top: place.top, width: Math.min(BUBBLE_WIDTH, Math.max(0, box.width - 2 * GAP)) }}
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape' && !event.defaultPrevented) props.onCancel(); }}
      onKeyUp={keep} onKeyPress={keep}
      onPointerDown={keep} onPointerUp={keep} onPointerMove={keep} onPointerCancel={keep}
      onClick={keep} onDoubleClick={keep} onContextMenu={keep} onWheel={keep}
      onPaste={keep} onCopy={keep} onCut={keep}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <span aria-hidden className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold tabular-nums text-primary-foreground">{number}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {/* No Escape on a phone: the same cancel, by touch. */}
        <button type="button" disabled={busy} onClick={props.onCancel} aria-label={t('browserPanel.annotations.bubble.cancel')} title={t('browserPanel.annotations.bubble.cancel')}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
          <X className="size-3.5" />
        </button>
      </div>
      <textarea
        ref={field}
        rows={2}
        value={text}
        disabled={busy}
        aria-label={t('browserPanel.annotations.bubble.field')}
        placeholder={t('browserPanel.annotations.bubble.placeholder')}
        className="max-h-40 min-h-[3rem] w-full resize-none rounded-md bg-background px-2 py-1.5 text-sm outline-none ring-1 ring-input focus:ring-2 focus:ring-ring"
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') { event.preventDefault(); props.onCancel(); return; }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (typed && !busy) props.onAdd(text);
          }
        }}
      />
      {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
      <div className="flex items-center gap-1.5">
        {mode === 'edit' && (
          <button type="button" disabled={busy} onClick={props.onDelete} aria-label={t('browserPanel.annotations.delete')}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
            <Trash2 className="size-3.5" />
          </button>
        )}
        <span className="flex-1 text-[10px] text-muted-foreground">{t('browserPanel.annotations.bubble.hint')}</span>
        <button type="button" disabled={!typed || busy} onClick={() => props.onAdd(text)}
          className="rounded-md bg-background px-2 py-1 text-xs hover:bg-muted disabled:opacity-40">
          {mode === 'new' ? t('browserPanel.annotations.bubble.add') : t('browserPanel.annotations.bubble.save')}
        </button>
        <button type="button" disabled={!canSend || busy || sendCount < 1} onClick={() => props.onSend(text)}
          title={canSend ? undefined : t('browserPanel.annotations.noConversation')}
          className={cn('inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40')}>
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}
          <span className="tabular-nums">{t('browserPanel.annotations.bubble.send', { count: sendCount })}</span>
        </button>
      </div>
    </div>
  );
}

/** A numbered pin on the element of a queued annotation; a click reopens its bubble. */
export function AnnotationPin({ number, rect, comment, onOpen }: { number: number; rect: SurfaceRect; comment: string; onOpen(): void }) {
  return (
    <button
      type="button"
      data-annotation-pin={number}
      aria-label={t('browserPanel.annotations.bubble.pin', { n: number, comment })}
      title={comment}
      className="pointer-events-auto absolute z-[5] inline-flex size-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold tabular-nums text-primary-foreground shadow-md ring-2 ring-background"
      style={{ left: Math.max(0, rect.left - 10), top: Math.max(0, rect.top - 10) }}
      onPointerDown={keep} onPointerUp={keep} onPointerMove={keep} onKeyDown={keep}
      onClick={(event) => { event.stopPropagation(); onOpen(); }}
    >
      {number}
    </button>
  );
}
