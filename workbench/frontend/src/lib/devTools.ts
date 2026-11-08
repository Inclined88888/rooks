/**
 * "Show developer tools" (Settings, Advanced): one switch that lists the Terminal, Code, coding jobs, the run log and
 * the other developer pages again, and shows Chat's Plan and Build coding modes. Off on a new install. The install
 * keeps it (the server's settings), so every window and paired browser agrees; the shell reads it from /api/status
 * and sets it here, and anything outside the shell's props reads it with useDevTools().
 */
import { useSyncExternalStore } from "react";
import type { WorkMode } from "../chat/types";

let on = false;
const listeners = new Set<() => void>();

export function devToolsOn(): boolean {
  return on;
}

export function setDevTools(next: boolean): void {
  if (next === on) return;
  on = next;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useDevTools(): boolean {
  return useSyncExternalStore(subscribe, devToolsOn, devToolsOn);
}

/** The chat's mode: Plan and Build are coding modes, so with the switch off every chat is a plain chat. */
export function chatMode(saved: WorkMode, devTools: boolean): WorkMode {
  return devTools ? saved : "chat";
}
