/**
 * The thread stays pinned to the newest line while a reply streams in, unless you scrolled up to read: then it stays
 * where you are until you scroll back down or send something. Pure, so it can be tested without a browser.
 */
export const PIN_SLACK_PX = 80;

/** True when the view is at (or within a few lines of) the bottom. */
export function isPinned(el: { scrollHeight: number; scrollTop: number; clientHeight: number }, slack = PIN_SLACK_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

/** How to follow new content: jump while words stream in (a smooth scroll per chunk lags behind), glide otherwise. */
export function followBehavior(streaming: boolean, motionOff: boolean): ScrollBehavior {
  return streaming || motionOff ? "auto" : "smooth";
}
