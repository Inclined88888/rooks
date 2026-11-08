/**
 * What the Room's Terminal window and its panes share in this browser (docs/design/0006-room-desktop.md, section 3.1).
 * The panes live in the keeper (terminalHost.tsx, "room") so their shells stay attached while you are in chat; the
 * window (tabs, chrome bar, verbs) lives on the page. This small store is the bridge: which tab is showing, each pane's
 * words, how to send keys to it and focus it, and the phone's Ctrl latch. The terminal list itself is never here: ids,
 * names, order and state come from the Room's status.
 */
import { useSyncExternalStore } from "react";
import { isLoopbackHost } from "./desk";

export type PaneWords = {
  /** The chrome bar's words for this pane (Opening…, Picked up…, This terminal ended.). */
  line: string;
  /** The socket was refused: "remote" (not this computer), "settings" (terminals are off), or "" when it was not. */
  blocked: "" | "remote" | "settings";
  /** The shell's socket is open. */
  open: boolean;
  /** A button the chrome bar offers: "here" (Use it here, after it was opened in another window), "reconnect", or none. */
  action?: "" | "here" | "reconnect";
};

type State = {
  active: string | null;
  words: Record<string, PaneWords>;
  /** The page is not on the computer running Rooks, or the service refused the socket for that reason. */
  remote: boolean;
  /** Terminals are switched off in Settings (the service said so when a socket was refused). */
  switchedOff: boolean;
  ctrl: boolean;
  /** Terminals the person took from Rooks in this browser (the service also knows; this is for the words at once). */
  taken: Record<string, boolean>;
  /** When each Rooks command was seen to finish (for "Done (code 0)" over 30 s). */
  doneAt: Record<string, number>;
};

/** A page that is not on the computer running Rooks cannot open the full terminal (the service only allows loopback). */
const startsRemote = typeof location !== "undefined" && !isLoopbackHost(location.hostname);

let state: State = { active: null, words: {}, remote: startsRemote, switchedOff: false, ctrl: false, taken: {}, doneAt: {} };
const listeners = new Set<() => void>();
const senders = new Map<string, (data: string) => void>();
const focusers = new Map<string, () => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  for (const fn of listeners) fn();
}

export function useTerms(): State {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => state,
    () => state,
  );
}

export function getTerms(): State {
  return state;
}

export function setActiveTerminal(id: string | null) {
  if (state.active !== id) set({ active: id });
}

export function setPaneWords(id: string, words: Partial<PaneWords>) {
  const cur = state.words[id] ?? { line: "", blocked: "", open: false, action: "" };
  const next = { ...cur, ...words };
  if (cur.line === next.line && cur.blocked === next.blocked && cur.open === next.open && (cur.action ?? "") === (next.action ?? "")) return;
  const patch: Partial<State> = { words: { ...state.words, [id]: next } };
  if (next.blocked === "remote") patch.remote = true;
  if (next.blocked === "settings") patch.switchedOff = true;
  set(patch);
}

/**
 * Status says terminals are on (status.ts calls this on each answer that says so): forget a socket's "switched off"
 * refusal, on the page and on each pane, so the panes are drawn again and their sockets asked again.
 */
export function clearSwitchedOff() {
  if (!state.switchedOff && !Object.values(state.words).some((w) => w.blocked === "settings")) return;
  const words: Record<string, PaneWords> = {};
  for (const [id, w] of Object.entries(state.words)) words[id] = w.blocked === "settings" ? { ...w, blocked: "", line: "" } : w;
  set({ switchedOff: false, words });
}

export function setCtrlLatch(on: boolean) {
  if (state.ctrl !== on) set({ ctrl: on });
}

export function markTaken(id: string, taken = true) {
  set({ taken: { ...state.taken, [id]: taken } });
}

export function markDone(id: string, at: number) {
  set({ doneAt: { ...state.doneAt, [id]: at } });
}

/** A pane registers how to type into its shell (null when its socket goes). */
export function registerSender(id: string, send: ((data: string) => void) | null) {
  if (send) senders.set(id, send); else senders.delete(id);
}

/** A pane registers how to focus its terminal (null when it goes). */
export function registerFocus(id: string, focus: (() => void) | null) {
  if (focus) focusers.set(id, focus); else focusers.delete(id);
}

const reattachers = new Map<string, () => void>();

/** A pane registers how to join its shell again (Use it here, Reconnect); null when it goes. */
export function registerReattach(id: string, again: (() => void) | null) {
  if (again) reattachers.set(id, again); else reattachers.delete(id);
}

/** Join a pane's shell again (the chrome bar's Use it here and Reconnect). False when that pane is not there. */
export function reattachTerminal(id: string | null): boolean {
  const again = id ? reattachers.get(id) : undefined;
  if (!again) return false;
  again();
  return true;
}

/** Send keys to a pane's shell as they are (the phone's key row). False when that pane is not connected. */
export function sendRaw(id: string | null, data: string): boolean {
  const send = id ? senders.get(id) : undefined;
  if (!send) return false;
  send(data);
  return true;
}

export function focusTerminal(id: string | null): boolean {
  const f = id ? focusers.get(id) : undefined;
  if (!f) return false;
  f();
  return true;
}
