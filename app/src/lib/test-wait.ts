/**
 * Test-only helper: wait, under React's `act()`, for something the test can
 * observe — a node painted, a request sent — instead of sleeping a fixed time.
 *
 * A fixed sleep is a bet on the machine's load: 60 ms held when a file ran
 * alone and lost one run in two inside the full app suite (TODO #430 review).
 * A bounded condition only costs what the machine actually needs, and its
 * failure names what never came instead of a later, unrelated assertion.
 *
 * `act` is passed in rather than imported: the tests install their jsdom
 * window before loading React, and must stay in control of that order.
 */

type Act = (callback: () => Promise<void>) => Promise<unknown>;

export const WAIT_LIMIT_MS = 5_000;
const POLL_MS = 5;

export async function waitUntil(
  act: Act,
  condition: () => boolean,
  what: string,
  limitMs: number = WAIT_LIMIT_MS,
): Promise<void> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    // Always flush once: effects and resolved promises queued by the gesture
    // that preceded the wait land before the first look.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, POLL_MS)); });
    if (condition()) return;
    if (Date.now() >= deadline) throw new Error(`waited ${limitMs} ms for ${what}`);
  }
}
