'use client';

/**
 * The two plugin slots of the built-in browser's chrome (TODO #461):
 *
 * - `browser.toolbar` (list): controls painted in the address bar, before the
 *   options button — a record button, a status pill;
 * - `browser.drawer` (keyed): a panel a plugin opens over the page. It takes
 *   the same modal path as the product's drawers, since the native view is
 *   painted above the DOM and would cover anything else;
 * - `browser.surface` (list, TODO #468): a layer over the page's picture (the
 *   video or the screenshot), positioned with `useBrowserSurface()`. Under the
 *   native view it is neither seen nor reached (`native`), which the occupant
 *   reads rather than guesses. A layer that handles a pointer event calls
 *   `preventDefault()`: the surface then sends nothing of it to the page.
 *
 * Both are declared at boot (`ui-layout.tsx`), not by the panel: a client
 * half registers when the plugins load, long before a browser is on screen,
 * and a slot that only existed while a panel is mounted would refuse it.
 *
 * Occupants read the browser from `useBrowserChrome()`, never from props: an
 * entry is registered once and painted in every open browser.
 *
 * `command()` drives a signed-in session (navigate, type, fill saved
 * credentials) through the user's own route, where the daemon cannot tell a
 * plugin's call from the product's. So it is gated here, on the manifest
 * permission `browser:control` of the plugin that registered the entry
 * (`SlotEntry.pluginId`, set by the registry, not by the plugin). Without it
 * the field is still there and rejects with a message naming the permission:
 * a third-party author reads what to declare instead of a `TypeError`, and
 * the hook keeps one shape for every occupant.
 */

import React, { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import { useSlotEntries, useSlotEntry } from '@/lib/plugin-host/render';
import type { SlotEntry } from '@/lib/plugin-host/slots';
import { PluginBoundary } from '@/lib/plugin-host/plugin-boundary';
import { BROWSER_CONTROL_PERMISSION, clientPermissionsVersion, clientPluginHolds, subscribeClientPermissions } from '@/lib/plugin-host/plugin-permissions';
import type { BrowserCommand, NativeBrowserStatus } from '@/lib/native-browser';

export const BROWSER_TOOLBAR_SLOT = 'browser.toolbar';
export const BROWSER_DRAWER_SLOT = 'browser.drawer';
export const BROWSER_SURFACE_SLOT = 'browser.surface';

/** Prefix of a plugin drawer in the panel's drawer state, so it never collides with the product's. */
export const PLUGIN_DRAWER_PREFIX = 'slot:';
export type PluginDrawer = `${typeof PLUGIN_DRAWER_PREFIX}${string}`;

export type BrowserChrome = {
  /** The profile this browser shows; `null` while none is bound. */
  profileId: string | null;
  /** Last status read from the engine; `null` until the first one. */
  status: NativeBrowserStatus | null;
  /** This client holds the control lease: input and navigation commands go through. */
  controlled: boolean;
  /**
   * The conversation this browser is open for: its agent, and its mission when it has one. It
   * follows the chat of that agent when one is on screen; `fresh` is that chat on "New conversation".
   */
  conversation: { agent: string; mission: string | null; fresh?: boolean };
  /**
   * A command on this profile, under this client's lease; the status is re-read
   * after it. Rejects without running anything when the occupant's plugin does
   * not declare `browser:control` (`browserControlDenied`).
   */
  command: BrowserCommand;
  /** The `browser.drawer` key open in this browser, or `null`. */
  drawer: string | null;
  /** Opens the `browser.drawer` entry registered under `key`. No entry: nothing happens. */
  openDrawer: (key: string) => void;
  /** Closes whatever drawer is open. */
  closeDrawer: () => void;
};

/** Where the page's picture sits, for a `browser.surface` layer. */
export type BrowserSurface = {
  /** The native view is painted above the DOM: a layer is neither seen nor reached. */
  native: boolean;
  /** A drawer, a dialog or a missing picture covers the page: a layer stands aside. */
  blocked: boolean;
  /** The page's viewport, in CSS pixels. */
  viewport: { width: number; height: number };
  /** A point of the window (`clientX`, `clientY`) in page CSS pixels; `null` off the picture. */
  toPage(clientX: number, clientY: number): { x: number; y: number } | null;
  /** A page rectangle in pixels of the surface, for an absolutely positioned layer; `null` off the picture. */
  toSurface(rect: { x: number; y: number; width: number; height: number }): { left: number; top: number; width: number; height: number } | null;
};

const BrowserChromeContext = createContext<BrowserChrome | null>(null);
const BrowserSurfaceContext = createContext<BrowserSurface | null>(null);
/** The plugin whose entry is being painted, set by the two slot hosts below. */
const BrowserOccupantContext = createContext<string | null>(null);

/** Error `command()` rejects with for an occupant whose plugin lacks `browser:control`. */
export function browserControlDenied(pluginId: string | null): Error {
  const who = pluginId === null ? 'outside a browser.toolbar / browser.drawer entry,' : `plugin \`${pluginId}\`:`;
  const error = new Error(`${who} command() of useBrowserChrome() needs the \`${BROWSER_CONTROL_PERMISSION}\` permission in the plugin's manifest (rooks.permissions)`);
  error.name = 'BrowserControlDenied';
  return error;
}

/** The browser a `browser.toolbar` / `browser.drawer` occupant is painted in; `null` outside them. */
export function useBrowserChrome(): BrowserChrome | null {
  const chrome = useContext(BrowserChromeContext);
  const pluginId = useContext(BrowserOccupantContext);
  useSyncExternalStore(subscribeClientPermissions, clientPermissionsVersion, clientPermissionsVersion);
  const allowed = clientPluginHolds(pluginId, BROWSER_CONTROL_PERMISSION);
  return useMemo(() => {
    if (!chrome || allowed) return chrome;
    const denied: BrowserCommand = () => Promise.reject(browserControlDenied(pluginId));
    return { ...chrome, command: denied };
  }, [chrome, allowed, pluginId]);
}

/**
 * The plugin whose `browser.toolbar` / `browser.drawer` entry is painting, `null` outside them.
 * Set by the slot host from the registry, never by the plugin: a hook that drives the browser
 * through another route (the recording plugin's) gates itself on it like `command()`.
 */
export function useBrowserOccupantPlugin(): string | null {
  return useContext(BrowserOccupantContext);
}

/** The picture a `browser.surface` occupant is layered on; `null` outside that slot. */
export function useBrowserSurface(): BrowserSurface | null {
  return useContext(BrowserSurfaceContext);
}

/** One entry, painted under its plugin's identity: what `useBrowserChrome()` gates `command()` on. */
function OccupantEntry({ entry }: { entry: SlotEntry }): React.ReactElement {
  const Component = entry.Component;
  return (
    <PluginBoundary pluginId={entry.pluginId}>
      <BrowserOccupantContext.Provider value={entry.pluginId}><Component /></BrowserOccupantContext.Provider>
    </PluginBoundary>
  );
}

export function BrowserChromeProvider({ value, children }: { value: BrowserChrome; children: React.ReactNode }): React.ReactElement {
  return <BrowserChromeContext.Provider value={value}>{children}</BrowserChromeContext.Provider>;
}

/** Nothing at all while no plugin holds the slot: a stock bar keeps its exact markup. */
export function BrowserToolbarSlot(): React.ReactElement | null {
  const entries = useSlotEntries(BROWSER_TOOLBAR_SLOT);
  if (entries.length === 0) return null;
  return <div data-browser-toolbar="" className="flex shrink-0 items-center gap-0.5">{entries.map((entry) => <OccupantEntry key={entry.id} entry={entry} />)}</div>;
}

/**
 * The open plugin drawer, in a dialog over the surface. The host paints the
 * frame only — title, close button and content belong to the occupant, as in
 * the product's own drawers (Escape still closes it).
 */
export function BrowserDrawerSlot({ entryKey, label }: { entryKey: string; label: string }): React.ReactElement | null {
  const entry = useSlotEntry(BROWSER_DRAWER_SLOT, entryKey);
  if (!entry) return null;
  return (
    <section role="dialog" aria-modal="true" aria-label={label} data-browser-drawer={entryKey} className="absolute inset-0 z-20 overflow-y-auto bg-card">
      <OccupantEntry entry={entry} />
    </section>
  );
}

/**
 * The layers over the page's picture, inside the remote surface. The frame lets pointer events
 * through; an occupant takes them where it paints something that does.
 */
export function BrowserSurfaceSlot({ value }: { value: BrowserSurface }): React.ReactElement | null {
  const entries = useSlotEntries(BROWSER_SURFACE_SLOT);
  if (entries.length === 0) return null;
  return (
    <BrowserSurfaceContext.Provider value={value}>
      <div data-browser-surface="" className="pointer-events-none absolute inset-0 z-[15]">
        {entries.map((entry) => <OccupantEntry key={entry.id} entry={entry} />)}
      </div>
    </BrowserSurfaceContext.Provider>
  );
}
