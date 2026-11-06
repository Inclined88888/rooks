/**
 * The "Discover Timon" slides, pure (docs/ONBOARDING.md, `Discover`): their order, the
 * product views each one names, and how long one stays before the next. The
 * drawings live in `discover/`; the step that plays them in `steps/discover.tsx`.
 *
 * Four slides, one idea each, from the agent alone to the whole platform. The
 * third is the reason the slides exist: a project's TIMs live in that project
 * only, with its rules and its memory — no other assistant is built that way,
 * and nobody guesses it from the TIMs page.
 */

export const DISCOVER_SLIDE_IDS = ['autonomous', 'teams', 'projects', 'connected'] as const;
export type DiscoverSlideId = typeof DISCOVER_SLIDE_IDS[number];

/**
 * The product views a slide shows, as chips under its text: the names the
 * person will meet in the navigation (`onboarding.discover.views.<id>`).
 */
export const DISCOVER_VIEWS: Readonly<Record<DiscoverSlideId, readonly string[]>> = {
  autonomous: ['canvas', 'chat'],
  teams: ['kanban', 'multichat'],
  projects: ['projectChat', 'widgets'],
  connected: ['connectors', 'workflows', 'plugins'],
};

/**
 * How long a slide plays before the next one, read at a glance: the four of
 * them take about half a minute. The last one does not move on by itself —
 * leaving the slides is the person's gesture.
 */
export const DISCOVER_SLIDE_MS = 7000;

/** The slide after `index`, or `null` on the last one: the slides then end. */
export function nextSlide(index: number): number | null {
  return index + 1 < DISCOVER_SLIDE_IDS.length ? index + 1 : null;
}

export function previousSlide(index: number): number | null {
  return index > 0 ? index - 1 : null;
}

/** Does the slide at `index` move on by itself? Never the last one, never without motion. */
export function autoAdvances(index: number, reducedMotion: boolean): boolean {
  return !reducedMotion && nextSlide(index) !== null;
}

export type SegmentState = 'done' | 'current' | 'todo';

/** One state per progress bar: the ones before are full, the current one fills. */
export function discoverSegments(index: number): SegmentState[] {
  return DISCOVER_SLIDE_IDS.map((_, k) => (k < index ? 'done' : k === index ? 'current' : 'todo'));
}
