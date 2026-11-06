/**
 * Singleton store for GET /api/ui/agents/active.
 *
 * WHY: the strip lives in the TopBar, which renders it twice — once for the
 * desktop (`hidden md:contents`), once for mobile (`md:hidden`). Tailwind
 * only hides visually: both instances mount and both effects run. Each one
 * therefore opened its own setInterval AND its own EventSource, which gave
 * two GET /agents/active every 4s and two permanent SSE connections out of
 * the 6 the browser grants per origin over HTTP/1.1 (the app is served in
 * clear on timon.localhost, so without h2: the limit really bites).
 *
 * Here the polling and the SSE subscription live at module level, not at
 * component level: N mounts = 1 poll + 0 dedicated connection (it goes
 * through the `sseOn` singleton). The subscriber count starts the timer on
 * the first mount and stops it on the last unmount, so a page that does not
 * show the strip pays nothing.
 */

import { useSyncExternalStore } from 'react';
import { sseOn } from './sse-stream';
import type { ActiveAgent } from './agent-state';

const POLL_MS = 4000;

/**
 * Stream events that can change an agent's state: each asks for a refetch at
 * once instead of waiting for the next poll. The three `permission_*` names are
 * the aliases the daemon sends on the global stream for the card events, whose
 * own frame is a generic `event`.
 */
export const AGENT_STATE_EVENTS = [
  'mission_complete', 'turn_complete', 'permission_request', 'permission_resolved', 'permission_expired',
] as const;

export function onAgentStateEvent(fn: () => void): () => void {
  const unsubs = AGENT_STATE_EVENTS.map((type) => sseOn(type, () => fn()));
  return () => { for (const unsub of unsubs) unsub(); };
}

/** Stable reference returned as long as the server changes nothing:
 *  useSyncExternalStore compares by identity, so assigning a fresh array on
 *  every poll would re-render every subscriber for nothing. */
const EMPTY: ActiveAgent[] = [];

let agents: ActiveAgent[] = EMPTY;
let serialized = '[]';
let inFlight = false;
/** Daemon clock of the last answer, against our own clock at that moment. */
let clock: { server: number; local: number } | null = null;

const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let stopStateEvents: (() => void) | null = null;

async function refresh(): Promise<void> {
  // An SSE burst (mission_complete + turn_complete almost together) must not
  // pile up requests: the one in flight is left to finish.
  if (inFlight) return;
  inFlight = true;
  try {
    const r = await fetch('/api/ui/agents/active', { cache: 'no-store' });
    if (!r.ok) return;
    const j = (await r.json()) as { agents?: ActiveAgent[]; computed_at?: number };
    if (typeof j.computed_at === 'number') clock = { server: j.computed_at, local: Date.now() };
    const next = j.agents ?? [];
    const nextSerialized = JSON.stringify(next);
    if (nextSerialized === serialized) return;
    serialized = nextSerialized;
    agents = next;
    for (const fn of subscribers) fn();
  } catch {
    /* network down: keep the last known state, the next tick retries */
  } finally {
    inFlight = false;
  }
}

function start(): void {
  void refresh();
  timer = setInterval(() => { void refresh(); }, POLL_MS);
  // Any event that may change an agent's state → immediate refetch, without
  // waiting for the next tick.
  stopStateEvents = onAgentStateEvent(() => { void refresh(); });
}

function stop(): void {
  if (timer) { clearInterval(timer); timer = null; }
  stopStateEvents?.();
  stopStateEvents = null;
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  if (subscribers.size === 1) start();
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0) stop();
  };
}

/** "Now" on the daemon's clock, which stamps the missions' `started_at`: a
 *  browser on another machine may run minutes apart from it. */
export function activeAgentsNow(): number {
  return clock ? clock.server + (Date.now() - clock.local) : Date.now();
}

/** The same store outside React (the mascots' live-state store reads it): one poll for every reader. */
export const subscribeActiveAgents = subscribe;
export function readActiveAgents(): readonly ActiveAgent[] {
  return agents;
}

const getSnapshot = (): ActiveAgent[] => agents;
const getServerSnapshot = (): ActiveAgent[] => EMPTY;

/** List of the active agents, shared by every component that calls it. */
export function useActiveAgents(): ActiveAgent[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
