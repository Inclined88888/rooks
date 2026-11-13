'use client';

/**
 * A labelled group of a form and the "paper" surface of what is written at
 * length: shared by the task form and the attachments field.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Pure white in the light theme for what is read and written at length; the dark theme keeps the field's tint. */
export const PAPER_CLASS = 'bg-white hover:bg-white dark:bg-muted/50 dark:hover:bg-muted/70';

/** A labelled group of the form: a quiet label, the control, an optional help line. */
export function Field({ label, htmlFor, help, aside, children, className }: {
  label: ReactNode;
  htmlFor?: string;
  help?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const Label = htmlFor ? 'label' : 'span';
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex min-h-5 items-center gap-3">
        <Label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">{label}</Label>
        {aside && <div className="ml-auto flex items-center gap-2">{aside}</div>}
      </div>
      {children}
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}
