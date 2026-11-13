'use client';

/**
 * A batch of browser annotations in the thread (TODO #481): what the user pointed at and said,
 * numbered like the pins on the page, and what the agent made of each. Typed data only, drawn as
 * text: the block the agent read never reaches the thread, so it cannot be shown.
 *
 * "Details" reads the source the page reported, for its owner only, when opened.
 */

import { useEffect, useState } from 'react';
import { Check, ChevronRight, Clock, MessageSquareText, X } from 'lucide-react';
import { annotationPageLabel, annotationPages, type AnnotationCardLine, type AnnotationCardView } from '@/lib/annotation-card';
import { browserAnnotationApi, type BrowserAnnotationDetail } from '@/lib/browser-annotations';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

function StateMark({ line }: { line: AnnotationCardLine }) {
  const label = t(`browserPanel.annotations.card.state.${line.state}`);
  const Icon = line.state === 'resolved' ? Check : line.state === 'dismissed' ? X : Clock;
  return (
    <span
      data-annotation-state={line.state}
      title={line.note ? `${label} — ${line.note}` : label}
      className={cn('inline-flex size-5 shrink-0 items-center justify-center rounded-full',
        line.state === 'resolved' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
          : line.state === 'dismissed' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400' : 'bg-muted text-muted-foreground')}
    >
      <Icon aria-hidden className="size-3" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function sourceText(source: BrowserAnnotationDetail['source']): string {
  if (!source.detected) return t('browserPanel.annotations.sourceNotDetected');
  const file = source.file ? `${source.file}${source.line ? `:${source.line}` : ''}` : '';
  return [source.component, file].filter(Boolean).join(' · ') || source.framework;
}

function Details({ items }: { items: AnnotationCardLine[] }) {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    let live = true;
    for (const item of items) {
      // The owner's read of the annotation; anyone else gets nothing, and the line says so.
      void browserAnnotationApi.get(item.id)
        .then((detail) => { if (live) setSources((current) => ({ ...current, [item.id]: sourceText(detail.source) })); })
        .catch(() => { if (live) setSources((current) => ({ ...current, [item.id]: t('browserPanel.annotations.card.sourceUnavailable') })); });
    }
    return () => { live = false; };
  }, [open, items]);
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
        <ChevronRight aria-hidden className={cn('size-3 transition-transform', open && 'rotate-90')} />
        {t('browserPanel.annotations.card.details')}
      </button>
      {open && (
        <dl data-annotation-details="" className="mt-1 space-y-1.5 text-[11px] text-muted-foreground">
          {items.map((item, index) => (
            <div key={item.id} className="grid grid-cols-[auto_1fr] gap-x-2">
              <dt className="tabular-nums">{index + 1}</dt>
              <dd className="min-w-0 space-y-0.5">
                <p className="break-all">{item.url}</p>
                {item.selector && (
                  // code-font: a CSS selector is code
                  <p className="break-all font-mono">{item.selector}</p>
                )}
                <p>{t('browserPanel.annotations.card.source', { source: sources[item.id] ?? '…' })}</p>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** The card of one posted batch, inside the user's bubble. */
export function AnnotationCard({ card }: { card: AnnotationCardView }) {
  const [enlarged, setEnlarged] = useState<string | null>(null);
  const pages = annotationPages(card.items);
  const samePage = pages.length === 1;
  return (
    <div data-annotation-card={card.batchId} role="group" aria-label={t('browserPanel.annotations.card.label', { count: card.items.length })}
      className="mt-1 w-full min-w-[16rem] space-y-2 rounded-lg bg-background/70 p-2.5 text-foreground">
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <MessageSquareText aria-hidden className="size-3.5 shrink-0 text-primary" />
        <span className="font-medium tabular-nums">{card.items.length === 1 ? t('browserPanel.annotations.card.countOne') : t('browserPanel.annotations.card.count', { count: card.items.length })}</span>
        {samePage && <span className="min-w-0 truncate text-muted-foreground" title={card.items[0]?.url}>· {pages[0]}</span>}
      </div>
      <ol className="space-y-2">
        {card.items.map((item, index) => (
          <li key={item.id} data-annotation-line={item.id} className="flex min-w-0 items-start gap-2">
            <span aria-hidden className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold tabular-nums text-primary-foreground">
              {index + 1}
            </span>
            {item.thumbnail && (
              <button type="button" className="shrink-0 rounded-md" aria-label={t('browserPanel.annotations.card.enlarge', { n: index + 1 })}
                onClick={() => setEnlarged(enlarged === item.id ? null : item.id)}>
                <img alt={t('browserPanel.annotations.thumbnailAlt')} src={item.thumbnail}
                  className={cn('rounded-md bg-muted object-contain', enlarged === item.id ? 'max-h-64 max-w-[16rem]' : 'size-12 object-cover')} />
              </button>
            )}
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className={cn('whitespace-pre-wrap break-words text-[13px]', !item.comment && 'italic text-muted-foreground')}>
                {item.comment || t('browserPanel.annotations.noComment')}
              </p>
              {!samePage && <p className="truncate text-[11px] text-muted-foreground" title={item.url}>{annotationPageLabel(item)}</p>}
              {item.note && (
                <p data-annotation-note="" className="text-[11px] text-muted-foreground">
                  {t(item.state === 'resolved' ? 'browserPanel.annotations.resolvedSummary' : 'browserPanel.annotations.dismissedReason',
                    item.state === 'resolved' ? { summary: item.note } : { reason: item.note })}
                </p>
              )}
            </div>
            <StateMark line={item} />
          </li>
        ))}
      </ol>
      <Details items={card.items} />
    </div>
  );
}
