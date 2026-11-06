'use client';

/**
 * The inside of a Kanban item's popup, whatever its nature: a TO DO idea or a
 * task (TODO #837). Presentation only — the zones arrive as nodes; it is
 * meant to sit in a `DetailFrame`, which owns the veil, the focus and Escape.
 *
 * Header and footer sit on the frame's chrome fill; the body, the attachments
 * and the meta rail are islands on it (`.timon-island`), apart by the island
 * gap. Nothing draws a separator (AGENTS.md rule 16): the rail stands out by
 * its own surface.
 */

import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type DetailShellProps = {
  /** The title (carrying the id the frame's `labelledBy` names) and its badges. */
  header: ReactNode;
  /** What one comes to read or edit: the description, the fields. */
  children?: ReactNode;
  /** What surrounds the item: links, dependencies, dates, plugin blocks. */
  rail?: ReactNode;
  /** Accessible name of the rail. */
  railLabel?: string;
  /** The attachments' thumbnails, under the body. */
  attachments?: ReactNode;
  /** Accessible name of the attachments zone. */
  attachmentsLabel?: string;
  /** Secondary gestures on the left, the main one on the right. */
  footer?: ReactNode;
  className?: string;
};

export function DetailShell({
  header, children, rail, railLabel, attachments, attachmentsLabel, footer, className,
}: DetailShellProps): ReactElement {
  return (
    <div data-detail-shell="" className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <header data-detail-shell-header="" className="flex flex-none flex-col gap-2 px-5 pb-3 pt-4">
        {header}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-[var(--timon-island-gap)] overflow-y-auto px-[var(--timon-island-gap)] lg:flex-row lg:overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col gap-[var(--timon-island-gap)] lg:min-h-0">
          <section data-detail-shell-body="" className="timon-island flex min-h-[40vh] flex-1 flex-col gap-3 px-5 py-4 lg:min-h-0 lg:overflow-y-auto">
            {children}
          </section>
          {attachments && (
            <section data-detail-shell-attachments="" aria-label={attachmentsLabel} className="timon-island flex flex-none flex-col gap-2 px-5 py-4">
              {attachments}
            </section>
          )}
        </div>
        {rail && (
          <aside data-detail-shell-rail="" aria-label={railLabel} className="timon-island flex w-full flex-none flex-col gap-5 px-4 py-4 lg:w-[300px] lg:overflow-y-auto">
            {rail}
          </aside>
        )}
      </div>
      {footer && (
        <footer data-detail-shell-footer="" className="flex flex-none items-center justify-between gap-2 px-5 py-3">
          {footer}
        </footer>
      )}
    </div>
  );
}
