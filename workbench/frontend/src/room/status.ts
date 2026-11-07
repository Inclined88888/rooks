/**
 * The Room's status, from one shared poller (lib/poller.ts) while any part of the app shows it (the Room page and the
 * Stage). The shell's pulse already says whether the Room runs and whether a turn works there, so this asks
 * GET /api/room/status only every 30 s while the Room is quiet, every 5 s while a turn works in it, never while the tab
 * is hidden, and at once when the pulse says the Room started, stopped or got busy. An action on the Room calls
 * refreshRoomStatus() so the screen follows it at once instead of waiting for the next tick.
 */
import { useEffect, useSyncExternalStore } from "react";
import { api, ApiError } from "../api";
import { createPoller } from "../lib/poller";
import { busy, getPresence, roomOn, subscribePresence, type Presence } from "../shell/presence";
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

export const ROOM_STATUS_QUIET_MS = 30000;
export const ROOM_STATUS_BUSY_MS = 5000;

/** A turn or a job is working in the Room right now (from the pulse). */
export function roomBusy(p: Pick<Presence, "where" | "mood" | "running">): boolean {
  return p.where === "room" && busy(p);
}

export const FRAME_LIVE_MS = 1000;
export const FRAME_WATCH_MS = 3000;

/**
 * How long until the next frame of the Room's screen: about one a second while you have stepped in or a turn works in
 * the Room, one every 3 s while you only watch a quiet Room, and none while the tab is hidden (the next frame is asked
 * when it is shown again).
 */
export function frameEvery(o: { captured: boolean; busy: boolean; hidden: boolean }): number | null {
  if (o.hidden) return null;
  return o.captured || o.busy ? FRAME_LIVE_MS : FRAME_WATCH_MS;
}

/** How often the Room's status is asked: null while the tab is hidden (asked again when it is shown). */
export function roomStatusEvery(p: Pick<Presence, "where" | "mood" | "running">, hidden: boolean): number | null {
  if (hidden) return null;
  return roomBusy(p) ? ROOM_STATUS_BUSY_MS : ROOM_STATUS_QUIET_MS;
}

let state: RoomState = START;
const listeners = new Set<() => void>();
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

async function load(): Promise<void> {
  try {
    const w = await api<RoomStatus>("/room/status");
    set(fromWire(w));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) set({ ...START, checked: true, reachable: true, available: false, label: NOT_HERE_LINE });
    else set({ ...state, checked: true, reachable: false });
  }
}

const poller = createPoller({ load, every: (hidden) => roomStatusEvery(getPresence(), hidden) });

/** The pulse says the Room started or stopped (it disagrees with the last status), or a turn began or ended there. */
let lastBusy = roomBusy(getPresence());
subscribePresence(() => {
  const p = getPresence();
  if (p.stub || poller.users() === 0) return;
  const b = roomBusy(p);
  const moved = b !== lastBusy || (state.checked && state.available && roomOn(p) !== state.running);
  lastBusy = b;
  if (moved) void poller.refresh();
});

/** Ask now (after Start, Stop, Save a point, Start over) instead of at the next tick. */
export function refreshRoomStatus(): Promise<void> {
  return poller.refresh();
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
  useEffect(() => poller.start(), []);
  return useSyncExternalStore(subscribeRoomStatus, getRoomStatus, getRoomStatus);
}

/** For tests: replace the state without the network. */
export function setRoomStatusForTests(next: Partial<RoomState>) {
  set({ ...state, ...next });
}
