'use client';

import { useId, useState } from 'react';
import { cn } from '@/lib/utils';
import { t as i18n } from '@/lib/i18n';

export type TaskLink = { id: string; kind?: 'dep' | 'chain' };

/**
 * A dependency badge that discloses the linked tasks. A `title` tooltip is
 * unreachable from the keyboard and on a touch screen, and these ids and
 * titles are what the user needs to unblock a deletion (TIM-0078): the badge
 * is a real button, the list unfolds on the card itself rather than in a
 * floating layer the scrolling column would clip.
 */
export function TaskLinksBadge({ label, header, links, byId, tone = 'muted' }: {
  label: string;
  header: string;
  links: TaskLink[];
  byId: ReadonlyMap<string, { title: string; status: string }>;
  /** `plain`: written as text in the card's footer ("Waits on 2 tasks"). */
  tone?: 'muted' | 'chain' | 'plain';
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        title={header}
        // The card opens its task on click: the badge keeps its click.
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        // The visual badge stays small, the hit box does not: the button is a
        // 24×24 minimum target (WCAG 2.2 target size) laid out in the row,
        // so it never overlaps a neighbour the way a stretched pseudo-element
        // would, and the row's gap keeps targets apart.
        className="group inline-flex min-h-6 min-w-6 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <span
          className={cn(
            'tabular-nums transition-colors',
            tone === 'plain'
              ? 'text-[12px] text-muted-foreground group-hover:text-primary'
              : 'rounded border px-1 text-[10px] group-hover:border-primary/50',
            tone === 'chain' && 'border-warning/40 bg-warning/10 text-warning',
            tone === 'muted' && 'border-border bg-muted/30 text-muted-foreground/70 group-hover:text-primary',
          )}
        >
          {label}
        </span>
      </button>
      {open && (
        // `order-last basis-full` puts the list on its own line under the
        // badge row, whichever badge opened it.
        <div
          id={listId}
          role="region"
          aria-label={header}
          onClick={(e) => e.stopPropagation()}
          className="order-last basis-full cursor-default rounded-md bg-muted/40 px-2 py-1.5 text-[11px] leading-snug"
        >
          <div className="mb-1 text-muted-foreground">{header}</div>
          <ul className="space-y-0.5">
            {links.map((link) => {
              const task = byId.get(link.id);
              return (
                <li key={link.id} className="break-words">
                  <span className="tabular-nums text-muted-foreground/70">#{link.id.slice(0, 8)}</span>{' '}
                  {task ? (
                    <>
                      <span className="text-foreground/90">{task.title}</span>{' '}
                      <span className="text-muted-foreground/70">({task.status})</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground/70">{i18n('kanbanPage.notOnBoard')}</span>
                  )}
                  {link.kind === 'chain' && (
                    <span className="text-warning"> · {i18n('kanbanPage.chainLink')}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}
