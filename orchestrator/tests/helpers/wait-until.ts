/**
 * Test-only: wait for something the test can observe instead of sleeping a fixed
 * time, the daemon side of `app/src/lib/test-wait.ts`.
 *
 * A fixed sleep is a bet on the machine's load: 50 ms held when a file ran alone
 * and lost inside a full suite (TODO #712). A bounded condition only costs what
 * the machine actually needs, and its failure names what never came.
 */
export const WAIT_LIMIT_MS = 30_000;
const POLL_MS = 10;

export async function waitUntil(check: () => boolean, what: string, limitMs: number = WAIT_LIMIT_MS): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`waited ${limitMs} ms for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * The window a test gives something that must NOT happen, once what had to
 * happen did. A fixed pause is right here: load can only shorten what it
 * catches, it can never turn a correct run red.
 */
export function quietWindow(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
