/**
 * The Room's status, from one shared poller (lib/poller.ts) while any part of the app shows it (the Room page and the
 * Stage). The shell's pulse already says whether the Room runs and whether a turn works there, so this asks
 * GET /api/room/status only every 30 s while the Room is quiet, every 5 s while a turn works in it, never while the tab
 * is hidden, and at once when the pulse says the Room started, stopped or got busy. An action on the Room calls
 * refreshRoomStatus() so the screen follows it at once instead of waiting for the next tick.
 *
 * The Room's terminals (docs/design/0006-room-desktop.md, section 4.4): their ids, names, order, owner and state come
 * from this answer on every refresh, never from the browser; a terminal action calls refreshRoomStatus() too. The
 * Commands window's lines (where a terminal cannot exist) live here as well, so leaving the page keeps them.
 */
import { useEffect, useSyncExternalStore } from "react";
import { api, ApiError } from "../api";
import { createPoller } from "../lib/poller";
import { busy, getPresence, roomOn, subscribePresence, type Presence } from "../shell/presence";
import { NOT_HERE_LINE, type RoomStatus, type RoomTerminal } from "./words";

/** A line of the Commands window: the command, its output, its errors, a note. */
export type CommandLine = { kind: "cmd" | "out" | "err" | "note"; text: string };

export type RoomState = RoomStatus & {
  /** The service has answered at least once. */
  checked: boolean;
  /** The last ask was answered (false: the service is away; the words on screen are the last known). */
  reachable: boolean;
  terminals: RoomTerminal[];
  terminal_max: number;
  can: { terminal: boolean; files: boolean };
  /** The Commands window's lines, for this session. */
  commandLines: CommandLine[];
};

/** How many terminals the Room may hold when the service does not say. */
export const TERMINAL_MAX = 4;
const COMMAND_LINES_MAX = 500;

const START: RoomState = {
  checked: false, reachable: true, available: false, running: false, screen: false, pointer: false, isolation: "none",
  label: "", note: "", checkpoints: [], last_checkpoint: null, error: null,
  terminals: [], terminal_max: TERMINAL_MAX, can: { terminal: false, files: false }, commandLines: [],
};

function terminalFromWire(t: unknown): RoomTerminal | null {
  if (!t || typeof t !== "object") return null;
  const w = t as Record<string, unknown>;
  if (typeof w.id !== "string" || !w.id) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    id: w.id,
    name: str(w.name) || "Terminal",
    owner: w.owner === "rooks" ? "rooks" : "person",
    alive: w.alive === true,
    busy: w.busy === true,
    started: str(w.started),
    exit_code: num(w.exit_code),
    ended_reason: str(w.ended_reason),
    command: str(w.command),
    elapsed_s: num(w.elapsed_s),
    taken: w.taken === true,
    shell: str(w.shell),
  };
}

/** The service's answer as the store keeps it. Anything it does not say is the plain default (nothing new can be done). */
export function roomFromWire(w: RoomStatus): Omit<RoomState, "commandLines"> {
  const terminals = Array.isArray(w.terminals) ? w.terminals.map(terminalFromWire).filter((t): t is RoomTerminal => t !== null) : [];
  const max = typeof w.terminal_max === "number" && w.terminal_max > 0 ? w.terminal_max : TERMINAL_MAX;
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
    terminals,
    terminal_max: max,
    can: { terminal: w.can?.terminal === true, files: w.can?.files === true },
  };
}

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

/** Take one answer from the service; the Commands window's lines are the session's and stay. */
export function receiveRoomStatus(w: RoomStatus): void {
  set({ ...roomFromWire(w), commandLines: state.commandLines });
}

/** Add lines to the Commands window (kept for the session, the last 500). */
export function addCommandLines(lines: CommandLine[]): void {
  set({ ...state, commandLines: [...state.commandLines, ...lines].slice(-COMMAND_LINES_MAX) });
}

async function load(): Promise<void> {
  try {
    const w = await api<RoomStatus>("/room/status");
    receiveRoomStatus(w);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) set({ ...START, checked: true, reachable: true, available: false, label: NOT_HERE_LINE, commandLines: state.commandLines });
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

/**
 * Read the last answer without asking for more: the Room's terminal panes stay mounted (parked) while you are elsewhere,
 * and they must not keep the poller going on their own. The page and the Stage, which do show the Room, poll.
 */
export function useRoomStatusQuiet(): RoomState {
  return useSyncExternalStore(subscribeRoomStatus, getRoomStatus, getRoomStatus);
}

/** For tests: replace the state without the network. */
export function setRoomStatusForTests(next: Partial<RoomState>) {
  set({ ...state, ...next });
}
