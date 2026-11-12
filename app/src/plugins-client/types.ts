'use client';

/**
 * Client half of a bundled module.
 *
 * A bundled module (`orchestrator/src/plugins-bundled/<id>/`) is a daemon
 * plugin: routes and jobs. Everything it puts on screen used to live in a
 * hard-coded table of the app instead — the nav list, the cockpit registry.
 * Its client half brings that surface back to the module that owns it, and
 * registers it in a slot, exactly like a third-party plugin does.
 *
 * The difference with a third-party plugin is deliberate and limited: this
 * code ships with the app, so it imports the product's components directly
 * and skips the admission check (a bundled module IS the product). It gains
 * nothing else — same slots, same disposal, same removal when the module is
 * switched off.
 */

import type { ComponentType } from 'react';
import type { Capabilities } from '@/lib/capabilities';
import type { RegisterOptions } from '@/lib/plugin-host/slots';
import type { ClientRealtime } from '@/lib/plugin-host/realtime';

export type BundledClientContext = {
  /** Module id, used as the plugin id of every entry it registers. */
  id: string;
  realtime: ClientRealtime;
  caps: Capabilities | null;
  /** False when `ui.hidden` lists the zone, or its module isn't running. */
  zoneVisible(zone: string): boolean;
  /** Options this module carries in `rooks.config.json` (`enabled` removed).
   *  Empty when the config says nothing — the half poses its own default. */
  options: Record<string, unknown>;
  register(options: Omit<RegisterOptions, 'pluginId'>, Component: ComponentType): () => void;
  /**
   * Runs when the halves are unmounted (capabilities changed, module switched
   * off). Only a half whose surfaces depend on something loaded *after*
   * `apply` needs it: it registers later, and outside the disposer list, so it
   * has to be told when to stop. A half that registers everything
   * synchronously never calls this.
   */
  onDispose(fn: () => void): void;
};

export type BundledClientPlugin = {
  /** Bundled module this half belongs to. Off → nothing registered. */
  module: string;
  /**
   * The half drives the LOCAL daemon whatever machine is active (Machines,
   * TODO #329): on a remote machine, the capabilities at hand are that
   * machine's, so they cannot say whether it runs here. A remote machine is
   * only ever active through the local module (it hands out the access), so
   * there the half is mounted; on this computer, only capabilities that name
   * the module as active mount it (off by default: never on a guess).
   */
  anchoredLocally?: boolean;
  /**
   * Manifest permissions the browser checks itself, which a bundled half must
   * declare like a third-party one (`browser:control` for the `command()` of
   * `useBrowserChrome()`). Absent: none. Daemon-side permissions do not go here:
   * a bundled module's host half is the product.
   */
  permissions?: readonly string[];
  apply(ctx: BundledClientContext): void;
};
