/**
 * HTML of a chat bubble, built when the bubble is drawn.
 *
 * Replaying a mission used to convert every text block (marked + DOMPurify +
 * highlight.js) and every tool call as it went through `ingest`, including the
 * hundreds of bubbles above the mounted window that nobody would scroll to.
 * The thread state now keeps the sources; a mounted bubble asks for its HTML
 * here. Both caches key on the highlighter version: a bubble drawn before the
 * grammars landed is drawn again, coloured, when they do.
 */

import { useMemo, useSyncExternalStore } from 'react';
import { getLocale } from '@/lib/i18n';
import { currentHighlighterVersion, mdToSafeHtml, subscribeHighlighter } from '@/lib/markdown';

/** Where the highlighter version comes from: `lib/markdown`, or a test's stand-in. */
export type HighlighterSource = {
  subscribe: (listener: () => void) => () => void;
  version: () => number;
};

const markdownHighlighter: HighlighterSource = {
  subscribe: subscribeHighlighter,
  version: currentHighlighterVersion,
};

/** Re-renders the caller once the highlight.js grammars are registered. */
export function useHighlighterVersion(source: HighlighterSource = markdownHighlighter): number {
  return useSyncExternalStore(source.subscribe, source.version, source.version);
}

/**
 * Concatenated HTML of markdown blocks, each converted once per (version,
 * locale) — the locale reaches the copy buttons' labels. Bounded, least
 * recently used out first: going back to a chat redraws from the cache, and a
 * long session does not keep every message it ever showed.
 */
export function createMarkdownHtmlCache(convert: (md: string) => string, max = 400) {
  const cache = new Map<string, string>();
  return (blocks: readonly string[], version: number): string => {
    const locale = getLocale();
    let html = '';
    for (const block of blocks) {
      const key = `${version}\u0000${locale}\u0000${block}`;
      let out = cache.get(key);
      if (out === undefined) {
        out = convert(block);
        if (cache.size >= max) cache.delete(cache.keys().next().value as string);
      } else {
        cache.delete(key);
      }
      cache.set(key, out);
      html += out;
    }
    return html;
  };
}

/** The agent's prose: same pipe as before, rendered on display. */
export const agentTextHtml = createMarkdownHtmlCache((md) => mdToSafeHtml(md, { copyLinks: true }));

/**
 * Per-object memo for tool calls. The thread replaces a call's object when its
 * result arrives and keeps the others, so object identity is the right key: a
 * result landing in a 40-call bubble renders one call, not forty.
 */
export function createObjectHtmlCache<T extends object, R>(render: (item: T) => R) {
  const cache = new WeakMap<T, { version: number; locale: string; out: R }>();
  return (item: T, version: number): R => {
    const locale = getLocale();
    const hit = cache.get(item);
    if (hit && hit.version === version && hit.locale === locale) return hit.out;
    const out = render(item);
    cache.set(item, { version, locale, out });
    return out;
  };
}

/**
 * HTML of a bubble's markdown blocks: converted on first draw, again only when
 * the blocks change or the grammars land (the race a replay used to lose — its
 * code blocks stayed grey for the whole session).
 */
export function useAgentTextHtml(
  text: readonly string[] | undefined,
  render: (blocks: readonly string[], version: number) => string = agentTextHtml,
  source?: HighlighterSource,
): string {
  const version = useHighlighterVersion(source);
  return useMemo(() => (text?.length ? render(text, version) : ''), [text, render, version]);
}
