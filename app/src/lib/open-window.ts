'use client';

/**
 * "Open in a new window" (multi-window V5, TODO #260): a page of the
 * desktop app opens one of its routes in one more window, on the machine this
 * window shows.
 *
 * Only the desktop shell has windows to open: on the web and in the PWA the
 * bridge is absent and every entry point hides itself. What crosses is a
 * route — a relative path checked by `safeRoute`, the same rule as the page a
 * machine switch lands on — and the id of the machine on screen; the shell
 * checks both again and builds the address from the window's own origin.
 *
 * The machine: a window the shell pinned keeps its pin (the shell's word wins);
 * an unpinned one names the machine its page was served for, so the new window
 * stays on it even if this one switches later.
 */
import { useEffect, useState } from 'react';
import { safeRoute } from '@/lib/machines/last-route';
import { activeMachineId } from '@/lib/machines/machine-storage';

type OpenWindowBridge = (request: { route: string; machineId?: string }) => Promise<unknown>;

function openWindowBridge(): OpenWindowBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.novaDesktop?.openWindow;
  return typeof bridge === 'function' ? bridge : null;
}

/** True in a desktop window that can open another one (absent from an older desktop). */
export function canOpenWindows(): boolean {
  return openWindowBridge() !== null;
}

/** The page on screen, as a route: path and query, no fragment. */
function currentRoute(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/**
 * Opens `route` (the page on screen by default) in a new window on this
 * window's machine. Resolves to `false` outside the desktop, for a route that
 * is not a page of the app (sign-in, setup, the API, another origin), or when
 * the shell declines (its interface is updating, a check is in progress).
 */
export async function openInNewWindow(route?: string): Promise<boolean> {
  const bridge = openWindowBridge();
  if (!bridge) return false;
  const safe = safeRoute(route ?? currentRoute());
  if (safe === null) return false;
  try {
    const result = await bridge({ route: safe, machineId: activeMachineId() });
    return (result as { opened?: unknown } | null)?.opened === true;
  } catch {
    return false;
  }
}

/**
 * `openInNewWindow` where a window can be opened, `null` elsewhere — the
 * caller hides its control on `null`. `null` on the server and at the first
 * render too, so the hydrated page matches the served one.
 */
export function useOpenInNewWindow(): ((route?: string) => Promise<boolean>) | null {
  const [available, setAvailable] = useState(false);
  useEffect(() => { setAvailable(canOpenWindows()); }, []);
  return available ? openInNewWindow : null;
}
