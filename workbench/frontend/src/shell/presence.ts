/**
 * The pulse: one poll for the whole shell (docs/design/0003-workroom.md, section 6, principle 4). GET /api/pulse
 * answers with the assistant's presence (name, mood, what it is doing, where, how many things need you), the job
 * notices since the last ask, and small revisions (`chats`, `held`) that move when a chat or a held call changes.
 * The presence strip, the phone bar, the rail's Room dot, the job notifier and the open chat all read this one answer
 * instead of asking /api/presence, /api/jobs/notices, /api/approvals and /api/conversations on their own timers.
 *
 * Cadence: every 4 s while something runs, every 10 s while quiet, every 30 s while the tab is hidden (the desktop
 * app still shows a notice from the background). An action asks at once with refreshPresence().
 *
 * Until the service has /api/pulse, a 404 falls back to /api/presence; until it has that, the idle line and the name
 * from the assistant settings.
 */
import { useEffect, useSyncExternalStore } from "react";
import { api, ApiError } from "../api";
import type { Mood } from "../AssistantFace";
import { browserEnv, createPoller, type PollEnv } from "../lib/poller";
import { plainStep } from "../plainStep";

export type Presence = {
  name: string;
  mood: Mood;
  doing: string;
  where: "room" | "browser" | "desktop" | "terminal" | "chat" | null;
  watching: string[];
  needs_you: number;
  running: { turns: number; jobs: number };
  /** True while the service does not have the presence route yet (the strip shows the idle line). */
  stub: boolean;
};

type Wire = Partial<Omit<Presence, "stub">> & {
  doing?: string | null; doing_tool?: string | null; doing_args?: string | null; where?: Presence["where"] | string | null; updated_at?: string;
};

export type Notice = { id: number; job_id: number; kind: "needs_you" | "finished" | "failed"; title: string; body: string; at: string };
export type Revs = { chats: string; held: string };
type PulseWire = { presence?: Wire; needs_you?: number; notices?: Notice[]; notices_after?: number; revs?: Partial<Revs> };

export const IDLE_LINE = "Quiet. Watching mail and calendar.";
const MOODS: Mood[] = ["idle", "thinking", "working", "done", "needs"];
const PLACES = ["room", "browser", "desktop", "terminal", "chat"] as const;
const START: Presence = { name: "Atlas", mood: "idle", doing: IDLE_LINE, where: null, watching: ["mail", "calendar"], needs_you: 0, running: { turns: 0, jobs: 0 }, stub: true };

/** How often the pulse asks: quick while something runs, calm while quiet, slow while the tab is hidden. */
export const PULSE_BUSY_MS = 4000;
export const PULSE_IDLE_MS = 10000;
export const PULSE_HIDDEN_MS = 30000;

export function busy(p: Pick<Presence, "mood" | "running">): boolean {
  return p.mood === "thinking" || p.mood === "working" || p.running.turns > 0 || p.running.jobs > 0;
}

export function pulseEvery(p: Pick<Presence, "mood" | "running">, hidden: boolean): number {
  if (hidden) return PULSE_HIDDEN_MS;
  return busy(p) ? PULSE_BUSY_MS : PULSE_IDLE_MS;
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The plain sentence for the strip. The service sends `doing`; a turn that has not called a tool yet is thinking, a
 * tool the service has no words for is said from its name (plainStep, "Working" when unknown), and only when nothing
 * runs do we say what it is watching.
 */
export function presenceLine(p: Pick<Presence, "doing" | "watching" | "mood"> & { doing_tool?: string | null }): string {
  if (p.doing) return p.doing;
  if (p.mood === "needs") return "Waiting for you.";
  if (p.mood === "thinking") return "Thinking…";
  if (p.mood === "working") return `${plainStep(p.doing_tool || "")}…`;
  if (p.watching.length) return `Quiet. Watching ${listWords(p.watching)}.`;
  return "Quiet.";
}

/** True while the Room runs: the presence answer lists it in `watching` (presence.py), so no second poller is needed. */
export function roomOn(p: Pick<Presence, "watching">): boolean {
  return p.watching.includes("room");
}

function fromWire(w: Wire, name: string): Presence {
  const mood = MOODS.includes(w.mood as Mood) ? (w.mood as Mood) : "idle";
  const where = PLACES.includes(w.where as (typeof PLACES)[number]) ? (w.where as Presence["where"]) : null;
  const watching = Array.isArray(w.watching) ? w.watching.filter((x): x is string => typeof x === "string") : [];
  const base = { name: w.name || name, mood, where, watching, needs_you: Number(w.needs_you) || 0,
    running: { turns: Number(w.running?.turns) || 0, jobs: Number(w.running?.jobs) || 0 }, stub: false, doing: "" };
  return { ...base, doing: presenceLine({ doing: w.doing || "", watching, mood, doing_tool: w.doing_tool }) };
}

export type PulseStore = ReturnType<typeof createPulseStore>;

/** The store, with the network and the clock passed in (the app uses `api` and the browser; tests pass fakes). */
export function createPulseStore(ask: <T>(path: string) => Promise<T> = api, env: PollEnv = browserEnv) {
  let state: Presence = START;
  let revs: Revs = { chats: "", held: "" };
  let cursor: number | null = null;
  let legacy = false;
  let nameLoaded = false;
  const listeners = new Set<() => void>();
  const revListeners = new Set<(r: Revs, before: Revs) => void>();
  const noticeListeners = new Set<(list: Notice[]) => void>();

  const set = (next: Presence) => {
    const cadence = pulseEvery(state, false) !== pulseEvery(next, false);
    state = next;
    for (const fn of listeners) fn();
    if (cadence) poller.reschedule();
  };

  async function load(): Promise<void> {
    try {
      if (legacy) { set(fromWire(await ask<Wire>("/presence"), state.name)); return; }
      const w = await ask<PulseWire>(cursor === null ? "/pulse" : `/pulse?after=${cursor}`);
      set(fromWire(w.presence ?? {}, state.name));
      const fresh = cursor !== null && Array.isArray(w.notices) ? w.notices : [];
      if (typeof w.notices_after === "number") cursor = w.notices_after;
      if (fresh.length) for (const fn of noticeListeners) fn(fresh);
      const next = { chats: String(w.revs?.chats ?? ""), held: String(w.revs?.held ?? "") };
      if (next.chats !== revs.chats || next.held !== revs.held) {
        const before = revs;
        revs = next;
        for (const fn of revListeners) fn(next, before);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404 && !legacy) { legacy = true; return load(); }
      // No presence route either (or the service is away): keep the idle line, but learn the name once.
      if (e instanceof ApiError && e.status === 404 && !nameLoaded) {
        nameLoaded = true;
        ask<{ assistant_name?: string }>("/assistant/settings")
          .then((r) => { if (r.assistant_name) set({ ...state, name: r.assistant_name }); })
          .catch(() => undefined);
      }
      if (!state.stub) set({ ...state, stub: true, mood: "idle", doing: IDLE_LINE, where: null, needs_you: state.needs_you });
    }
  }

  const poller = createPoller({ load, every: (hidden) => pulseEvery(state, hidden), env });

  return {
    poller,
    get: () => state,
    revs: () => revs,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    /** Called when a revision moves (not on the first answer). Keeps the pulse running while subscribed. */
    onRevs(fn: (r: Revs, before: Revs) => void) {
      const wrapped = (r: Revs, before: Revs) => { if (before.chats || before.held) fn(r, before); };
      revListeners.add(wrapped);
      const stop = poller.start();
      return () => { revListeners.delete(wrapped); stop(); };
    },
    /** New job notices, oldest first (never the ones from before the app opened). Keeps the pulse running. */
    onNotices(fn: (list: Notice[]) => void) {
      noticeListeners.add(fn);
      const stop = poller.start();
      return () => { noticeListeners.delete(fn); stop(); };
    },
    setForTests(next: Partial<Presence>) { set({ ...state, ...next }); },
  };
}

const pulse = createPulseStore();

/** Ask now (after a decision in Needs you, after a hand-off is held, when a turn starts) instead of at the next tick. */
export function refreshPresence(): Promise<void> {
  return pulse.poller.refresh();
}

export function subscribePresence(fn: () => void): () => void {
  return pulse.subscribe(fn);
}

export function getPresence(): Presence {
  return pulse.get();
}

/** Poll while at least one component shows the presence. */
export function usePresence(): Presence {
  useEffect(() => pulse.poller.start(), []);
  return useSyncExternalStore(subscribePresence, getPresence, getPresence);
}

/** Job notices as they arrive (the desktop notifier); the pulse carries them, there is no second poller. */
export function onNotices(fn: (list: Notice[]) => void): () => void {
  return pulse.onNotices(fn);
}

/** Run fn when a chat changed anywhere (`chats`) or a held call was raised or answered (`held`). */
export function useRevs(fn: (r: Revs, before: Revs) => void, deps: unknown[]): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => pulse.onRevs(fn), deps);
}

/** For tests and the strip: replace the whole state (no network). */
export function setPresenceForTests(next: Partial<Presence>) {
  pulse.setForTests(next);
}
