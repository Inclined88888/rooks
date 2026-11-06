'use client';

/**
 * What an `apps.card` occupant is painted for: one card of the Apps catalogue
 * (`/apps`). The slot passes no props — an entry is registered once and painted
 * by every card of the page — so each card host puts its own app here and the
 * occupant reads it with `useAppCard()`.
 *
 * The host owns the data and the gestures: it lists the catalogue, creates the
 * MCP server, opens the publisher's consent page, stores a key in the vault and
 * reads the state again. A replacement paints, and calls `connect` /
 * `disconnect`; it never talks to the daemon itself.
 */

import { createContext, useContext } from 'react';

export type AppCardCategory = 'code' | 'data' | 'design' | 'productivity' | 'business';

/**
 * - `available`: not connected.
 * - `connecting`: a gesture is under way.
 * - `consent`: the server exists, the publisher's consent is not given yet (or
 *   has expired): `connect()` opens the consent page again.
 * - `connected`: ready to be attached to an agent.
 * - `blocked`: an MCP server of the same id was added by hand; Apps leaves it alone.
 */
export type AppCardStatus = 'available' | 'connecting' | 'consent' | 'connected' | 'blocked';

export type AppCardAuth =
  | { type: 'oauth' }
  /** A token the user pastes: `label` names it, `helpUrl` is where the publisher issues it. */
  | { type: 'key'; label: string; helpUrl: string }
  | { type: 'none' };

/** A publisher's mark: path data in `viewBox`, never SVG markup. */
export type AppCardLogo = {
  viewBox: string;
  paths: readonly { d: string; fill?: string }[];
};

/** An entry of the catalogue, its texts already in the viewer's language. */
export type AppCardApp = {
  slug: string;
  name: string;
  publisher: string;
  category: AppCardCategory;
  tagline: string;
  description: string;
  examples: readonly string[];
  /** The publisher's MCP endpoint. */
  url: string;
  auth: AppCardAuth;
  links: { website: string; privacy: string; terms: string };
  /**
   * The brand tile: `color` is its background. `logo` is the publisher's mark
   * as SVG path data (a path without `fill` takes the ink that reads on
   * `color`); without it, the card paints `monogram`.
   */
  icon: { monogram: string; color: string; logo?: AppCardLogo };
  /** The MCP server the app is connected under (`app-<slug>`), to attach to an agent. */
  mcpId: string;
};

export type AppCardValue = {
  app: AppCardApp;
  status: AppCardStatus;
  /** The consent page last opened for this app, to open again when the browser blocked the tab. */
  consentUrl: string | null;
  /** The secrets vault is switched off: an app of type `key` cannot be connected. */
  vaultOff: boolean;
  /**
   * Connects the app (`key` required for `auth.type === 'key'`, refused otherwise); for `oauth`,
   * opens the publisher's consent page. `false` when it failed — the host has already said why.
   */
  connect: (key?: string) => Promise<boolean>;
  /** Asks for confirmation, then removes the server (and its key). `false` when refused or failed. */
  disconnect: () => Promise<boolean>;
};

const AppCardContext = createContext<AppCardValue | null>(null);

export const AppCardProvider = AppCardContext.Provider;

/** Readable by a plugin that takes the `apps.card` slot; `null` outside a card host. */
export function useAppCard(): AppCardValue | null {
  return useContext(AppCardContext);
}
