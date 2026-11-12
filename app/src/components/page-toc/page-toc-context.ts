'use client';

/**
 * What a `page.toc` occupant is painted for: the table of contents of a long
 * list page (the Skills and MCP tabs of Capabilities), shown in a sticky
 * column on its left. The slot passes no props: the host reads the headings of
 * the page and puts them here, the occupant reads them with `usePageToc()`.
 *
 * A heading enters the table by its markup alone, so a section painted by a
 * plugin (an `mcp.featured` occupant) is listed without any call: an element
 * with an `id` and `data-toc="<label>"`, optionally `data-toc-level="2"` (a
 * sub-section) and `data-toc-count="<n>"` (the number of items it holds).
 */

import { createContext, useContext } from 'react';

export type PageTocEntry = {
  /** The `id` of the heading, also its anchor. */
  id: string;
  label: string;
  /** 1: a section; 2: a sub-section of the section above it. */
  level: 1 | 2;
  /** The number of items the section holds, when the page says it. */
  count: number | null;
};

export type PageTocValue = {
  /** The headings of the page, in reading order; they follow its search filter. */
  entries: readonly PageTocEntry[];
  /** The section in view, `null` before the page has any. */
  active: string | null;
  /** Scrolls the page to that heading. */
  go: (id: string) => void;
};

const PageTocContext = createContext<PageTocValue | null>(null);

export const PageTocProvider = PageTocContext.Provider;

/** Readable by a plugin that takes the `page.toc` slot; `null` outside a page that has one. */
export function usePageToc(): PageTocValue | null {
  return useContext(PageTocContext);
}

/** Reads the headings marked `data-toc` under `root`, in document order. */
export function readTocEntries(root: ParentNode): PageTocEntry[] {
  const out: PageTocEntry[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-toc]'))) {
    const label = (el.dataset.toc ?? '').trim();
    if (!el.id || !label) continue;
    const count = Number.parseInt(el.dataset.tocCount ?? '', 10);
    out.push({ id: el.id, label, level: el.dataset.tocLevel === '2' ? 2 : 1, count: Number.isFinite(count) ? count : null });
  }
  return out;
}

export function sameEntries(a: readonly PageTocEntry[], b: readonly PageTocEntry[]): boolean {
  return a.length === b.length && a.every((e, i) => {
    const o = b[i];
    return !!o && o.id === e.id && o.label === e.label && o.level === e.level && o.count === e.count;
  });
}
