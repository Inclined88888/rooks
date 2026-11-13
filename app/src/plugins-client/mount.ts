'use client';

/**
 * Mounts the client halves of the bundled modules that are running.
 *
 * Called by `SlotRoot` once the layout has declared its slots, and re-run
 * whenever capabilities change: switching a module off must take its
 * surfaces away, which is the whole point of owning them per module.
 */

import {
  isLayoutSurfaceAllowed,
  isModuleOn,
  isThemeSurfaceAllowed,
  isZoneVisible,
  moduleOptions,
  type Capabilities,
} from '@/lib/capabilities';
import { register } from '@/lib/plugin-host/slots';
import { LOCAL_MACHINE_ID } from '@/lib/machines/machine-id';
import { activeMachineId } from '@/lib/machines/machine-storage';
import { createClientRealtime } from '@/lib/plugin-host/realtime';
import { grantClientPermissions } from '@/lib/plugin-host/plugin-permissions';
import { BUNDLED_CLIENT_PLUGINS } from './index';
import type { BundledClientPlugin } from './types';
import { UI_LAYOUT_MODULE } from './ui-layout';
import { UI_THEME_MODULE } from './ui-theme';

/**
 * Off-by-default modules are not shown on a guess: capabilities not loaded
 * yet, or silent about the module, would flash their surfaces in on every
 * install where they are off.
 */
function explicitlyOn(caps: Capabilities | null, module: string): boolean {
  return caps?.modules.find((entry) => entry.id === module)?.active === true;
}

export function mountBundledClients(caps: Capabilities | null, plugins: readonly BundledClientPlugin[] = BUNDLED_CLIENT_PLUGINS): () => void {
  const disposers: Array<() => void> = [];
  const remote = activeMachineId() !== LOCAL_MACHINE_ID;
  for (const plugin of plugins) {
    const on = plugin.anchoredLocally ? remote || explicitlyOn(caps, plugin.module) : isModuleOn(caps, plugin.module);
    if (!on) continue;
    // The product palette is a theme like any other: a viewer whose theme
    // surfaces are restricted must be able to leave the `theme` slot empty,
    // exactly as it stays empty when the module is switched off. Same
    // curtain for the product chrome (`ui-layout`). No other half is
    // filtered here.
    if (plugin.module === UI_THEME_MODULE && !isThemeSurfaceAllowed(caps, UI_THEME_MODULE)) continue;
    if (plugin.module === UI_LAYOUT_MODULE && !isLayoutSurfaceAllowed(caps, UI_LAYOUT_MODULE)) continue;
    // Same rule as a third-party half: a bundled one holds what it declares, nothing more.
    if (plugin.permissions?.length) disposers.push(grantClientPermissions(plugin.module, plugin.permissions));
    try {
      plugin.apply({
        id: plugin.module,
        realtime: createClientRealtime(plugin.module, (dispose) => disposers.push(dispose)),
        caps,
        zoneVisible: (zone) => isZoneVisible(caps, zone),
        options: moduleOptions(caps, plugin.module),
        register: (options, Component) => {
          const dispose = register({ ...options, pluginId: plugin.module }, Component);
          disposers.push(dispose);
          return dispose;
        },
        onDispose: (fn) => { disposers.push(fn); },
      });
    } catch (error) {
      // One broken half must not cost the others their surfaces.
      console.error(`[bundled-client:${plugin.module}] montage impossible`, error);
    }
  }
  return () => { for (const dispose of disposers.splice(0).reverse()) dispose(); };
}
