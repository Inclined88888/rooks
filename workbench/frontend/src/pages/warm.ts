/**
 * Pages open without waiting (docs/design/0003-workroom.md, section 6, principle 4). Each page is its own chunk; the
 * chunk is fetched as soon as a pointer rests on, or the keyboard lands on, a way to it (the rail, a rail flyout, the
 * More sheet, the phone bar, the command menu), so by the click it is usually here already. A page whose chunk is
 * loaded renders at once, with no Suspense step; one that is still on its way shows its frame and a Loading state.
 */
import { lazy, type ComponentType } from "react";
import { PAGES, type PageEntry } from "./registry";

type Comp = ComponentType<Record<string, unknown>>;

const loading = new Map<PageEntry, Promise<Comp>>();
const loaded = new Map<PageEntry, Comp>();
const lazies = new Map<PageEntry, Comp>();

/** Fetch the page's chunk once (every later call shares it). */
export function warmEntry(entry: PageEntry): Promise<Comp> {
  let p = loading.get(entry);
  if (!p) {
    p = entry.load().then((m) => {
      const c = m.default as Comp;
      loaded.set(entry, c);
      return c;
    });
    p.catch(() => loading.delete(entry)); // a failed fetch (offline) is tried again next time
    loading.set(entry, p);
  }
  return p;
}

/** The registry page a link goes to: its own path, an `also` pattern, or a path under it. */
export function entryFor(to: string): PageEntry | undefined {
  const path = (to.split(/[?#]/)[0] || "/").replace(/\/+$/, "") || "/";
  const exact = PAGES.find((p) => p.path === path);
  if (exact) return exact;
  const fits = (pattern: string) => {
    const a = pattern.split("/"), b = path.split("/");
    return a.length === b.length && a.every((seg, i) => seg.startsWith(":") || seg === b[i]);
  };
  return PAGES.find((p) => (p.also ?? []).some(fits)) ?? PAGES.find((p) => !p.path.includes(":") && path.startsWith(`${p.path}/`));
}

/** Warm the page a link goes to. Safe to call on every hover and focus. */
export function warmPath(to: string): void {
  const e = entryFor(to);
  if (e) void warmEntry(e).catch(() => undefined);
}

/** Props for a link or button that leads to a page: warm it on hover, focus and touch. */
export function warmProps(to: string) {
  const go = () => warmPath(to);
  return { onPointerEnter: go, onFocus: go, onTouchStart: go };
}

/** The component to render: the page itself once its chunk is here, else a lazy one that suspends until it is. */
export function pageComponent(entry: PageEntry): { C: Comp; ready: boolean } {
  const ready = loaded.get(entry);
  if (ready) return { C: ready, ready: true };
  let c = lazies.get(entry);
  if (!c) { c = lazy(() => warmEntry(entry).then((d) => ({ default: d }))) as Comp; lazies.set(entry, c); }
  return { C: c, ready: false };
}

/** True once the page's chunk is loaded (tests and the frame fallback). */
export function isWarm(entry: PageEntry): boolean {
  return loaded.has(entry);
}

/**
 * Once the app has settled, the pages the keyboard jumps to (g then c, r, j, t, m, s) are fetched in the background,
 * one at a time while the browser is idle, so the first visit to them does not wait either.
 */
export function warmWhenIdle(paths: string[], delayMs = 2500): () => void {
  let stop = false;
  const idle = (fn: () => void) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(fn, { timeout: 2000 }); else setTimeout(fn, 50);
  };
  const next = (i: number) => {
    if (stop || i >= paths.length) return;
    const e = entryFor(paths[i]);
    if (!e || loaded.has(e)) { next(i + 1); return; }
    warmEntry(e).catch(() => undefined).finally(() => idle(() => next(i + 1)));
  };
  const t = setTimeout(() => idle(() => next(0)), delayMs);
  return () => { stop = true; clearTimeout(t); };
}
