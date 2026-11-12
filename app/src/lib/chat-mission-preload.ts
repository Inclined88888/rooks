/**
 * The mission a chat switch is about to show, fetched before the new
 * conversation mounts.
 *
 * Switching chats re-keys `ChatClient`, and the new one would start empty and
 * fetch its mission from an effect: a blank conversation on screen until the
 * log lands. Instead `ChatRoute` starts this read as soon as the URL names
 * the next mission and suspends the switch (a transition, so the previous
 * conversation stays painted) until it has landed or `SWITCH_BUDGET_MS` has
 * passed. `bindMission` then takes the response instead of asking again.
 *
 * One-shot and short-lived on purpose: a response nobody took within
 * `TTL_MS` is dropped, a running mission's log moves on.
 */

import { historyPageUrl } from './chat-history-page';

/** Longest a switch keeps the previous conversation on screen. */
export const SWITCH_BUDGET_MS = 1500;
const TTL_MS = 5_000;

/** The read `bindMission` makes, the last page of the journal
 *  (`chat-history-page.ts`): a preload must ask exactly the same thing. */
export function missionDetailUrl(missionId: string): string {
  return historyPageUrl(missionId, null);
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

interface Entry {
  at: number;
  /** The response, its body already read: "ready" means the log is here. */
  response: Promise<Response>;
  /** Settles once the response is in or the budget is spent, never rejects. */
  wait: Promise<void>;
  waited: boolean;
}

const entries = new Map<string, Entry>();

function prune(now: number): void {
  for (const [id, entry] of entries) if (now - entry.at > TTL_MS) entries.delete(id);
}

/**
 * The mission a chat switch waits for: one named by the URL, when another
 * conversation (`shownKey`) is already on screen. A first opening shows the
 * page at once, and an agent-only switch has no mission to read ahead.
 */
export function chatSwitchMission(shownKey: string | null, key: string, mission: string | null): string | null {
  return shownKey !== null && shownKey !== key && mission ? mission : null;
}

/** Starts reading `missionId` unless a fresh read is already in flight. */
export function preloadChatMission(
  missionId: string,
  { fetcher = fetch, now = Date.now(), budgetMs = SWITCH_BUDGET_MS }: { fetcher?: Fetcher; now?: number; budgetMs?: number } = {},
): void {
  prune(now);
  if (entries.has(missionId)) return;
  const response = fetcher(missionDetailUrl(missionId), { cache: 'no-store' }).then(async (r) => {
    // Rebuilt around the body read in full, so the wait covers the transfer.
    const body = await r.text();
    return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
  });
  // `bindMission` reports the failure when it takes the response.
  response.catch(() => {});
  const entry: Entry = { at: now, response, wait: Promise.resolve(), waited: false };
  entry.wait = Promise.race([
    response.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, budgetMs)),
  ]).then(() => { entry.waited = true; });
  entries.set(missionId, entry);
}

/**
 * What a switch to `missionId` still has to wait for: a promise to suspend on,
 * or `null` once the read is in, the budget spent, or nothing was preloaded.
 */
export function chatMissionWait(missionId: string): Promise<void> | null {
  const entry = entries.get(missionId);
  return entry && !entry.waited ? entry.wait : null;
}

/** The preloaded response for `missionId`, handed out once; `null` when none is fresh. */
export function takePreloadedChatMission(missionId: string, now = Date.now()): Promise<Response> | null {
  prune(now);
  const entry = entries.get(missionId);
  if (!entry) return null;
  entries.delete(missionId);
  return entry.response;
}

/** Tests only. */
export function resetChatMissionPreloads(): void {
  entries.clear();
}
