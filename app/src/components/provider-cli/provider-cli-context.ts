'use client';

/**
 * What a `providers.cli` occupant is painted for: the provider cards of the
 * onboarding's "Your AIs" step, of Settings › AI models › Providers, and of
 * the onboarding's "cannot start" screen.
 *
 * The slot passes no props — an entry is registered once and painted by every
 * host — so each host (`ProviderCliCards`) puts its own value here and the
 * occupant reads it with `useProviderCliCards()`. The host owns the data and
 * the gestures: it fetches the list, starts an install, follows its console,
 * re-reads after a sign-in. A replacement paints, and calls these.
 */

import { createContext, useContext } from 'react';
import type { InstallJob, ProviderCli } from '@/lib/provider-clis';

export type ProviderCliCardsMode = 'onboarding' | 'settings' | 'recovery';

/** Where "Sign in" left the command: typed in Timon's terminal, copied, or neither. */
export type ProviderCliSignInOutcome = 'terminal' | 'copied' | 'failed';

export type ProviderCliCardsValue = {
  /** `onboarding`: the "Your AIs" step. `settings`: Settings › AI models. `recovery`: the chat could not start. */
  mode: ProviderCliCardsMode;
  /** The cards, in the product's order; `null` until the daemon answered. */
  backends: ProviderCli[] | null;
  /** The daemon refused the list or could not be reached: show nothing to act on. */
  unavailable: boolean;
  /** The install job of each CLI that has one — running, or the last one that ended. */
  jobs: Readonly<Record<string, InstallJob>>;
  /** `false` when the update check is switched off: no "Update available" is shown. */
  updateCheck: boolean;
  /** A gesture is under way (a refresh, a check): buttons that start another wait. */
  busy: boolean;
  /** Nothing may be started (the surface around is busy). */
  disabled: boolean;
  /** Runs the vendor's official installer of `name` (an update is the same gesture); the job is then followed. */
  install: (name: string) => Promise<void>;
  /** "Try again": asks every installed CLI again whether it is signed in. */
  refresh: () => Promise<void>;
  /** "Check for updates": asks the vendors for their newest version now. */
  checkUpdates: () => Promise<void>;
  /**
   * "Sign in": types the CLI's sign-in command, without Enter, in Timon's own terminal when the
   * view has one, else copies it for a terminal of the person's choice.
   */
  signIn: (name: string) => Promise<ProviderCliSignInOutcome>;
};

const ProviderCliCardsContext = createContext<ProviderCliCardsValue | null>(null);

export const ProviderCliCardsProvider = ProviderCliCardsContext.Provider;

/** Readable by a plugin that takes the `providers.cli` slot; `null` outside a host. */
export function useProviderCliCards(): ProviderCliCardsValue | null {
  return useContext(ProviderCliCardsContext);
}
