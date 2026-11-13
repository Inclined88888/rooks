'use client';

/**
 * A panel that slides in from the right INSIDE the Settings window.
 *
 * It is a Radix dialog so the focus trap, Escape and the return of focus come
 * from the same primitive as the window around it: two hand-made traps nested
 * in each other are how Escape ends up closing the whole of Settings. Its
 * portal targets that window rather than `document.body`, so it covers the
 * list it was opened from and nothing else. Outside a dialog (a page that
 * mounts the section directly) it falls back to the viewport.
 */

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { NativeViewCover } from '@/lib/native-view-cover';

export function SidePanel({ open, title, onClose, onSubmit, footer, children }: {
  open: boolean;
  title: string;
  onClose: () => void;
  onSubmit: () => void;
  /** Stays pinned at the bottom, visible without scrolling. */
  footer: ReactNode;
  children: ReactNode;
}): ReactElement {
  const anchor = useRef<HTMLSpanElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  /** What had the focus when the panel opened: the pencil, or "Add". */
  const opener = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setContainer(anchor.current?.closest<HTMLElement>('[role="dialog"]') ?? null);
  }, []);

  // A layout effect, so it runs before the dialog's own effect moves the
  // focus inside the panel: read later, the opener would be lost.
  useLayoutEffect(() => {
    if (open) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [open]);

  const position = container ? 'absolute' : 'fixed';
  return (
    <>
      <span ref={anchor} hidden />
      <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
        <DialogPrimitive.Portal container={container ?? undefined}>
          <DialogPrimitive.Overlay
            className={cn(position, 'inset-0 z-50 bg-black/25 data-[state=open]:animate-in data-[state=open]:fade-in-0')}
          />
          <DialogPrimitive.Content
            ref={content}
            aria-describedby={undefined}
            className={cn(
              position,
              'inset-y-0 right-0 z-50 flex w-full max-w-[820px] flex-col bg-card shadow-elev-3 outline-none',
              'data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=open]:duration-300',
            )}
            onEscapeKeyDown={(event) => {
              // An emoji list opened inside the panel is a popup of its own:
              // Escape closes it, not the panel under it.
              const target = event.target instanceof Element ? event.target : null;
              const popup = target?.closest('[role="dialog"]');
              if (popup && popup !== content.current) event.preventDefault();
            }}
            onCloseAutoFocus={(event) => {
              // Radix would return the focus to whatever held it last; the
              // list may have re-rendered since, so aim at the opener itself.
              if (opener.current?.isConnected) {
                event.preventDefault();
                opener.current.focus();
              }
            }}
          >
            <NativeViewCover />
            <form
              className="flex min-h-0 flex-1 flex-col"
              onSubmit={(event: FormEvent) => { event.preventDefault(); onSubmit(); }}
            >
              <header className="flex items-center gap-3 px-5 py-3">
                <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em]">
                  {title}
                </DialogPrimitive.Title>
                <DialogPrimitive.Close
                  type="button"
                  aria-label={t('common.close')}
                  title={t('common.close')}
                  className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
                >
                  <X className="size-4" />
                </DialogPrimitive.Close>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
              <footer className="flex flex-wrap items-center gap-2 bg-muted/20 px-5 py-3">{footer}</footer>
            </form>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
