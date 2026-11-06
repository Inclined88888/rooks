'use client';

import { useEffect, useState } from 'react';

/**
 * Minimal channel between the topbar's "Browser" button (rendered in
 * `(main)/layout.tsx`) and the side panel (mounted in the root layout,
 * outside the pages, so the built-in browser survives navigation).
 *
 * The two live in separate React trees: a context would have to go up to the
 * root layout and would re-render the whole cockpit on every opening. A
 * CustomEvent on `window` is enough and couples nothing.
 */

export const BROWSER_PANEL_LS_OPEN = 'timon-browser-open';

/** Emitted by the button, listened to by the panel. */
export const BROWSER_PANEL_TOGGLE = 'timon:browser-toggle';
/** Opens the window (an island tab handing the browser back to it). */
export const BROWSER_PANEL_OPEN = 'timon:browser-open';
/** Emitted by the panel on every VISIBILITY change. */
export const BROWSER_PANEL_STATE = 'timon:browser-state';
/** Emitted by a mounting subscriber, to ask the panel for its current state. */
export const BROWSER_PANEL_QUERY = 'timon:browser-state-query';
export const BROWSER_PANEL_CONTEXT = 'timon:browser-context';
export const BROWSER_PANEL_CONTEXT_QUERY = 'timon:browser-context-query';
export type BrowserMissionContext = { agent: string; missionId: string | null };

/**
 * A batch of browser annotations reached a conversation of `agent` (TODO #481): a chat of that
 * agent showing no conversation, or another one, opens it, as after its own first message.
 */
export const BROWSER_ANNOTATIONS_POSTED = 'timon:browser-annotations-posted';
export type BrowserAnnotationsPosted = { agent: string; missionId: string };

export function announceBrowserAnnotationsPosted(posted: BrowserAnnotationsPosted): void {
  window.dispatchEvent(new CustomEvent<BrowserAnnotationsPosted>(BROWSER_ANNOTATIONS_POSTED, { detail: posted }));
}

/**
 * The conversation the chat page shows for `agent`, as it publishes it; `null` while no chat of
 * that agent is on screen. `missionId: null` is the chat on "New conversation".
 */
export function useChatConversation(agent: string): BrowserMissionContext | null {
  const [context, setContext] = useState<BrowserMissionContext | null>(null);
  useEffect(() => {
    const onContext = (event: Event) => {
      const detail = (event as CustomEvent<BrowserMissionContext | null>).detail;
      setContext((current) => {
        if (!detail) return null;
        if (detail.agent !== agent) return current?.agent === agent ? null : current;
        return current?.agent === detail.agent && current.missionId === detail.missionId ? current : detail;
      });
    };
    window.addEventListener(BROWSER_PANEL_CONTEXT, onContext);
    window.dispatchEvent(new CustomEvent(BROWSER_PANEL_CONTEXT_QUERY));
    return () => window.removeEventListener(BROWSER_PANEL_CONTEXT, onContext);
  }, [agent]);
  return context?.agent === agent ? context : null;
}

export type BrowserPanelState = { open: boolean };

export function toggleBrowserPanel(): void {
  window.dispatchEvent(new CustomEvent(BROWSER_PANEL_TOGGLE));
}

export function publishBrowserPanelState(open: boolean): void {
  window.dispatchEvent(
    new CustomEvent<BrowserPanelState>(BROWSER_PANEL_STATE, { detail: { open } }),
  );
}

/**
 * Asks the panel for its state. Essential for a subscriber that mounts AFTER
 * the last publication — and localStorage cannot play that role: it keeps
 * `open` ("the pane is unfolded"), which says nothing of the real visibility,
 * which depends on the current page and the project read there.
 */
export function requestBrowserPanelState(): void {
  window.dispatchEvent(new CustomEvent(BROWSER_PANEL_QUERY));
}

/**
 * Follows the VISIBILITY of the side panel from any client component — not
 * its unfolded/folded state: the panel stays unfolded while crossing a page
 * that does not show it. `false` on the first render, then corrected after
 * mount: no hydration mismatch, the value only changes in an effect.
 */
export function useBrowserPanelOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onState = (e: Event) => {
      setOpen((e as CustomEvent<BrowserPanelState>).detail.open);
    };
    window.addEventListener(BROWSER_PANEL_STATE, onState);
    // Subscribe first, ask second: the answer arrives synchronously and would
    // be missed in the reverse order.
    requestBrowserPanelState();
    return () => window.removeEventListener(BROWSER_PANEL_STATE, onState);
  }, []);
  return open;
}
