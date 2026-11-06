/**
 * Decision logic of the mobile header that hides while the user scrolls down.
 *
 * Hiding the bar frees height, so the scrollable range shrinks and the browser
 * clamps `scrollTop` back up: on a page barely taller than the screen that
 * clamp reads as a scroll-up, the bar comes back, the range grows again, and
 * the bar flickers in a loop (TIM-0060). Three guards break it: no hiding
 * unless the page stays scrollable once the bar is gone, a lock after every
 * change during which layout shifts are absorbed, and a cumulative scroll-up
 * distance (not the last delta) to bring the bar back.
 */
export const REVEAL_AT = 64;
export const MIN_DELTA = 6;
export const MIN_RANGE = 240;
export const REVEAL_TRAVEL = 28;
export const LOCK_MS = 280;

export interface HeaderScrollState {
  hidden: boolean;
  lockUntil: number;
  /** Per scroll container. */
  lastY: number;
  upTravel: number;
}

export function nextHeaderScrollState(
  s: HeaderScrollState,
  input: { y: number; range: number; now: number },
): HeaderScrollState {
  const { y, range, now } = input;
  // The header's own transition moves the content: not the user scrolling.
  if (now < s.lockUntil) return { ...s, lastY: y, upTravel: 0 };
  const delta = y - s.lastY;
  if (Math.abs(delta) < MIN_DELTA) return s;
  const upTravel = delta < 0 ? s.upTravel - delta : 0;
  const next = { ...s, lastY: y, upTravel };
  const flip = (hidden: boolean): HeaderScrollState => ({
    ...next,
    hidden,
    upTravel: 0,
    lockUntil: now + LOCK_MS,
  });
  if (y < REVEAL_AT) return s.hidden ? flip(false) : next;
  if (!s.hidden && delta > 0 && range >= MIN_RANGE) return flip(true);
  if (s.hidden && upTravel >= REVEAL_TRAVEL) return flip(false);
  return next;
}

/** Timing of the phone header's slide: one curve for the bar and what follows it. */
export const TOPBAR_SLIDE: KeyframeAnimationOptions = { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' };

/**
 * Keyframes of the slide, played once the layout has already switched: each
 * element starts where it was painted the frame before and ends at rest.
 * `shift` is the menu bar's height. Folding, the content under the bar moved
 * up by it, so it starts that much lower; unfolding, the reverse.
 */
export function topbarSlideFrames(folded: boolean, shift: number): { bar: Keyframe[]; follower: Keyframe[] } {
  return {
    bar: folded
      ? [{ transform: 'translateY(0)' }, { transform: 'translateY(-100%)' }]
      : [{ transform: 'translateY(-100%)' }, { transform: 'translateY(0)' }],
    follower: [{ transform: `translateY(${folded ? shift : -shift}px)` }, { transform: 'translateY(0)' }],
  };
}
