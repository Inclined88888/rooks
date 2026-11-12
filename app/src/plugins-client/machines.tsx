'use client';

import dynamic from 'next/dynamic';
import { MACHINES_MODULE } from '@/lib/machines/fleet';
import { MachineSwitcher } from './machines/switcher';
import type { BundledClientPlugin } from './types';

// Loaded on demand (docs/BUNDLE-SIZE.md): statically imported, every page of the app paid for it.
const MachinesSettings = dynamic(() => import('./machines/settings').then((m) => m.MachinesSettings), { ssr: false });

/**
 * Client half of `@rooks/machines` (TODO #329, P3d): Settings → Machines and
 * the switcher at the foot of the nav. Off by default, like its host module.
 *
 * Anchored on this computer: what it shows and does goes through the LOCAL
 * daemon, so it follows the local module's state, not the active machine's —
 * a remote machine without the plugin must not take the way back away.
 */
export const machinesClient: BundledClientPlugin = {
  module: MACHINES_MODULE,
  anchoredLocally: true,
  apply(ctx) {
    ctx.register({ slot: 'settings.section' }, MachinesSettings);
    ctx.register({ slot: 'nav.footer' }, MachineSwitcher);
  },
};
