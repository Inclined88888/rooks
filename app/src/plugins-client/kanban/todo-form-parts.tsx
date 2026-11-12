'use client';

/** Pieces shared by the popups of a TO DO idea, its detail and its creation (TODO #837). */

import type { ReactElement, ReactNode } from 'react';
import { X } from 'lucide-react';
import { t } from '@/lib/i18n';

/** A named group of the side rail: a quiet label, then its content. The label is
 *  the locale's lower-case word, capitalised by CSS. */
export function RailGroup({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): ReactElement {
  return (
    <section className="flex flex-col gap-1.5" title={hint}>
      <h3 className="text-[11px] font-medium text-muted-foreground first-letter:uppercase">{label}</h3>
      <div className="text-[12.5px] text-foreground">{children}</div>
    </section>
  );
}

/** The frame has no close button of its own, and below `md` it fills the screen without a veil to click. */
export function TodoFormClose({ onClose }: { onClose: () => void }): ReactElement {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label={t('common.close')}
      className="grid size-8 flex-none place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <X className="size-4" aria-hidden />
    </button>
  );
}
