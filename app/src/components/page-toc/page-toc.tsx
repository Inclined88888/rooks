'use client';

/**
 * The table of contents of a long list page, and the host that paints it.
 * `PageTocLayout` wraps the page's sections: it reads the headings marked
 * `data-toc`, follows the one in view as the page scrolls, and paints the
 * `page.toc` slot's occupant in a sticky column on the left — the product's
 * table (`ProductPageToc`) while no plugin took the slot.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { PAGE_TOC_SLOT } from '@/lib/plugin-host/slots';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { PageTocProvider, readTocEntries, sameEntries, usePageToc, type PageTocEntry, type PageTocValue } from './page-toc-context';

/** How far below the top edge a heading counts as the section in view, and where a jump puts it. */
const READ_LINE_PX = 48;
const JUMP_GAP_PX = 12;
/** How long the spy leaves the clicked entry lit while the smooth scroll runs. */
const JUMP_LOCK_MS = 1000;

/** The element that scrolls the page: the nearest ancestor with its own scroll, `null` for the window. */
export function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return p;
  }
  return null;
}

/**
 * The section in view: the last heading above the read line, the first one
 * before any; the last one once the page is scrolled to its end, since a short
 * last section never reaches the line.
 */
export function sectionInView(
  entries: readonly PageTocEntry[],
  headingTop: (id: string) => number | null,
  frame: { top: number; atEnd: boolean },
): string | null {
  if (entries.length === 0) return null;
  if (frame.atEnd) return entries[entries.length - 1]!.id;
  let current = entries[0]!.id;
  for (const entry of entries) {
    const top = headingTop(entry.id);
    if (top === null) continue;
    if (top - frame.top <= READ_LINE_PX) current = entry.id;
    else break;
  }
  return current;
}

function frameOf(scroller: HTMLElement | null): { top: number; atEnd: boolean } {
  if (scroller) {
    const scrolls = scroller.scrollHeight > scroller.clientHeight + 2;
    return { top: scroller.getBoundingClientRect().top, atEnd: scrolls && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2 };
  }
  const doc = document.documentElement;
  const scrolls = doc.scrollHeight > window.innerHeight + 2;
  return { top: 0, atEnd: scrolls && window.scrollY + window.innerHeight >= doc.scrollHeight - 2 };
}

function headingTop(id: string): number | null {
  const el = document.getElementById(id);
  return el ? el.getBoundingClientRect().top : null;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function PageTocLayout({ children }: { children: ReactNode }): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const lockUntil = useRef(0);
  const [entries, setEntries] = useState<PageTocEntry[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const claimed = useSlotEntries(PAGE_TOC_SLOT).length > 0;

  // The headings follow the page: its data arriving, its search filtering.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const read = () => setEntries((prev) => {
      const next = readTocEntries(content);
      return sameEntries(prev, next) ? prev : next;
    });
    read();
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(read);
    observer.observe(content, { childList: true, subtree: true, attributes: true, attributeFilter: ['id', 'data-toc', 'data-toc-level', 'data-toc-count'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const scroller = scrollParent(rootRef.current);
    const update = () => {
      if (Date.now() < lockUntil.current) return;
      setActive(sectionInView(entries, headingTop, frameOf(scroller)));
    };
    update();
    if (entries.length === 0) return;
    const target: HTMLElement | Window = scroller ?? window;
    let frame = 0;
    const onScroll = () => { window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(update); };
    target.addEventListener('scroll', onScroll, { passive: true });
    return () => { target.removeEventListener('scroll', onScroll); window.cancelAnimationFrame(frame); };
  }, [entries]);

  const go = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const scroller = scrollParent(rootRef.current);
    const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';
    lockUntil.current = Date.now() + JUMP_LOCK_MS;
    setActive(id);
    const offset = el.getBoundingClientRect().top - frameOf(scroller).top - JUMP_GAP_PX;
    if (scroller) {
      if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: scroller.scrollTop + offset, behavior });
    } else if (typeof window.scrollTo === 'function') {
      window.scrollTo({ top: window.scrollY + offset, behavior });
    }
  }, []);

  const value = useMemo<PageTocValue>(() => ({ entries, active, go }), [entries, active, go]);

  return (
    <div ref={rootRef} className="flex items-start gap-8">
      {entries.length > 0 && (
        <aside className="sticky top-4 hidden max-h-[calc(100vh-6rem)] w-44 shrink-0 overflow-y-auto lg:block">
          <PageTocProvider value={value}>
            {claimed ? <SlotSingle name={PAGE_TOC_SLOT} /> : <ProductPageToc />}
          </PageTocProvider>
        </aside>
      )}
      <div ref={contentRef} className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** The product's table: one link per heading, the section in view lit, sub-sections indented. */
export function ProductPageToc(): ReactElement | null {
  const toc = usePageToc();
  if (!toc || toc.entries.length === 0) return null;
  const jump = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    toc.go(id);
  };
  return (
    <nav aria-label={t('pageToc.label')} className="flex flex-col gap-0.5">
      <div className="mb-1 px-2 text-[11.5px] font-medium text-muted-foreground">{t('pageToc.title')}</div>
      {toc.entries.map((entry) => {
        const on = entry.id === toc.active;
        return (
          <a
            key={entry.id}
            href={`#${entry.id}`}
            onClick={(e) => jump(e, entry.id)}
            aria-current={on ? 'location' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1 text-[12.5px] no-underline transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              entry.level === 2 && 'pl-5',
              on ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.count !== null && <span className="shrink-0 text-[11.5px] font-normal tabular-nums text-muted-foreground">{entry.count}</span>}
          </a>
        );
      })}
    </nav>
  );
}
