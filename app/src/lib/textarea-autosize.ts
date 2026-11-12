/** Height cap of the chat composer, shared by the keystroke fit and the width observer. */
export const COMPOSER_MAX_HEIGHT = 200;

/** Subset of HTMLTextAreaElement the fit needs, so tests can drive it without a DOM. */
export interface FitTarget {
  style: { height: string };
  scrollHeight: number;
  scrollTop: number;
}

/**
 * Grow the composer textarea up to `max` px.
 *
 * Going through `height: auto` on every keystroke re-lays the box out and
 * resets its internal scroll position once the text overflows the cap, which
 * is what made the screen jump on touch. Growing only needs `scrollHeight`
 * (it already reflects the content when the box is too small), so the reset is
 * kept for `shrink` — text got shorter — and the scroll position is restored
 * either way.
 */
export function fitTextarea(el: FitTarget, max: number, shrink: boolean): void {
  const scrollTop = el.scrollTop;
  if (shrink) el.style.height = 'auto';
  const next = Math.min(max, el.scrollHeight) + 'px';
  if (el.style.height !== next) el.style.height = next;
  if (el.scrollTop !== scrollTop) el.scrollTop = scrollTop;
}

/**
 * Refit when the box gets a new width, never on a height-only change.
 *
 * A textarea mounted narrow (an island before its first measure, a closed side
 * panel) wraps its placeholder over many lines and sticks at `max`; the
 * keystroke path never shrinks an empty field, so nothing brought it back
 * down. A new width changes the wrapping in both directions, hence `shrink`.
 * Our own height writes also notify the observer: filtering on width keeps
 * `height: auto` off the typing path. A zero width (hidden box) is skipped and
 * not recorded, so the refit happens when it shows again.
 */
export function createWidthRefit(refit: () => void): (width: number) => void {
  let last = -1;
  return (width) => {
    if (width <= 0 || width === last) return;
    last = width;
    refit();
  };
}

/**
 * Keep `el` fitted to its content as its width or its placeholder changes;
 * returns the teardown.
 *
 * The placeholder lays out like text in an empty field: switching to an agent
 * with a shorter one (or to the "working" hint and back) kept the height of
 * the longer one, since neither the width nor the text had changed.
 */
export function observeTextareaWidth(el: FitTarget & Element, max: number): () => void {
  const teardown: Array<() => void> = [];
  if (typeof ResizeObserver !== 'undefined') {
    const onWidth = createWidthRefit(() => fitTextarea(el, max, true));
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) onWidth(entry.contentRect.width);
    });
    ro.observe(el);
    teardown.push(() => ro.disconnect());
  }
  if (typeof MutationObserver !== 'undefined') {
    const mo = new MutationObserver(() => fitTextarea(el, max, true));
    mo.observe(el, { attributes: true, attributeFilter: ['placeholder'] });
    teardown.push(() => mo.disconnect());
  }
  return () => { for (const stop of teardown) stop(); };
}
