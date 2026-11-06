/**
 * The assistant's presence: name, mood, what it is doing, where, and how many things need you. One poller shared by
 * the presence strip and the phone bar (GET /api/presence every 5 s, section 8 of the design record). Until the service
 * has that route, a 404 falls back to the idle line and the name from the assistant settings.
 */
import { useEffect, useSyncExternalStore } from "react";
import { api, ApiError } from "../api";
import type { Mood } from "../AssistantFace";

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

type Wire = Partial<Omit<Presence, "stub">> & { doing?: string | null; where?: Presence["where"] | string | null; updated_at?: string };

export const IDLE_LINE = "Quiet. Watching mail and calendar.";
const MOODS: Mood[] = ["idle", "thinking", "working", "done", "needs"];
const PLACES = ["room", "browser", "desktop", "terminal", "chat"] as const;

let state: Presence = { name: "Atlas", mood: "idle", doing: IDLE_LINE, where: null, watching: ["mail", "calendar"], needs_you: 0, running: { turns: 0, jobs: 0 }, stub: true };
const listeners = new Set<() => void>();
let users = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let inflight = false;
let wanted = false;
let nameLoaded = false;

function set(next: Presence) {
  state = next;
  for (const fn of listeners) fn();
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The plain sentence for the strip. The service sends `doing`; when it is quiet we say what it is watching. */
export function presenceLine(p: Pick<Presence, "doing" | "watching" | "mood">): string {
  if (p.doing) return p.doing;
  if (p.mood === "needs") return "Waiting for you.";
  if (p.watching.length) return `Quiet. Watching ${listWords(p.watching)}.`;
  return "Quiet.";
}

function fromWire(w: Wire): Presence {
  const mood = MOODS.includes(w.mood as Mood) ? (w.mood as Mood) : "idle";
  const where = PLACES.includes(w.where as (typeof PLACES)[number]) ? (w.where as Presence["where"]) : null;
  const watching = Array.isArray(w.watching) ? w.watching.filter((x): x is string => typeof x === "string") : [];
  const base = { name: w.name || state.name, mood, where, watching, needs_you: Number(w.needs_you) || 0,
    running: { turns: Number(w.running?.turns) || 0, jobs: Number(w.running?.jobs) || 0 }, stub: false, doing: "" };
  return { ...base, doing: presenceLine({ doing: w.doing || "", watching, mood }) };
}

async function tick(): Promise<void> {
  if (inflight) { wanted = true; return; }
  inflight = true;
  try {
    const w = await api<Wire>("/presence");
    set(fromWire(w));
  } catch (e) {
    // No presence route yet (or the service is away): keep the idle line, but learn the name once.
    if (e instanceof ApiError && e.status === 404 && !nameLoaded) {
      nameLoaded = true;
      api<{ assistant_name?: string }>("/assistant/settings")
        .then((r) => { if (r.assistant_name) set({ ...state, name: r.assistant_name }); })
        .catch(() => undefined);
    }
    if (!state.stub) set({ ...state, stub: true, mood: "idle", doing: IDLE_LINE, where: null, needs_you: state.needs_you });
  } finally {
    inflight = false;
    clearTimeout(timer);
    if (wanted) { wanted = false; void tick(); }
    else if (users > 0) timer = setTimeout(() => void tick(), document.hidden ? 15000 : 5000);
  }
}

/** Ask now (after a decision in Needs you, after a hand-off is held) instead of at the next tick. */
export function refreshPresence(): Promise<void> {
  clearTimeout(timer);
  return tick();
}

function start() {
  users += 1;
  if (users === 1) { clearTimeout(timer); void tick(); }
  return () => {
    users -= 1;
    if (users === 0) clearTimeout(timer);
  };
}

export function subscribePresence(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getPresence(): Presence {
  return state;
}

/** Poll while at least one component shows the presence. */
export function usePresence(): Presence {
  useEffect(() => start(), []);
  return useSyncExternalStore(subscribePresence, getPresence, getPresence);
}

/** For tests and the strip: replace the whole state (no network). */
export function setPresenceForTests(next: Partial<Presence>) {
  set({ ...state, ...next });
}
