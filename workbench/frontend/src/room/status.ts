/**
 * The Room's status, from one shared poller: GET /api/room/status every 5 s (15 s when the tab is hidden) while any
 * part of the app shows it (the rail's live dot, the bottom bar, the Room page and the Stage). An action on the Room
 * calls refreshRoomStatus() so the screen follows it at once instead of waiting for the next tick.
 */
import { useEffect, useSyncExternalStore } from "react";
import { api, ApiError } from "../api";
import { NOT_HERE_LINE, type RoomStatus } from "./words";

export type RoomState = RoomStatus & {
  /** The service has answered at least once. */
  checked: boolean;
  /** The last ask was answered (false: the service is away; the words on screen are the last known). */
  reachable: boolean;
};

const START: RoomState = {
  checked: false, reachable: true, available: false, running: false, screen: false, pointer: false, isolation: "none",
  label: "", note: "", checkpoints: [], last_checkpoint: null, error: null,
};

let state: RoomState = START;
const listeners = new Set<() => void>();
let users = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let inflight = false;
let wanted = false;

function set(next: RoomState) {
  state = next;
  for (const fn of listeners) fn();
}

function fromWire(w: RoomStatus): RoomState {
  return {
    ...w,
    checked: true,
    reachable: true,
    available: w.available !== false,
    running: w.running === true,
    screen: w.screen === true,
    pointer: w.pointer === true,
    isolation: w.isolation || "none",
    label: w.label || "",
    note: w.note || "",
    checkpoints: Array.isArray(w.checkpoints) ? w.checkpoints.filter((c) => c && typeof c.name === "string") : [],
    last_checkpoint: w.last_checkpoint || null,
  };
}

function schedule() {
  clearTimeout(timer);
  if (users > 0) timer = setTimeout(() => void tick(), document.hidden ? 15000 : 5000);
}

async function tick(): Promise<void> {
  if (inflight) { wanted = true; return; }
  inflight = true;
  try {
    const w = await api<RoomStatus>("/room/status");
    set(fromWire(w));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) set({ ...START, checked: true, reachable: true, available: false, label: NOT_HERE_LINE });
    else set({ ...state, checked: true, reachable: false });
  } finally {
    inflight = false;
    if (wanted) { wanted = false; void tick(); } else schedule();
  }
}

/** Ask now (after Start, Stop, Save a point, Start over) instead of at the next tick. */
export function refreshRoomStatus(): Promise<void> {
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

export function subscribeRoomStatus(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getRoomStatus(): RoomState {
  return state;
}

/** Poll while at least one component shows the Room. */
export function useRoomStatus(): RoomState {
  useEffect(() => start(), []);
  return useSyncExternalStore(subscribeRoomStatus, getRoomStatus, getRoomStatus);
}

/** For tests: replace the state without the network. */
export function setRoomStatusForTests(next: Partial<RoomState>) {
  set({ ...state, ...next });
}
