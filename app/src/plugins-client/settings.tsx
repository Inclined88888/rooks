'use client';

import dynamic from 'next/dynamic';
import type { BundledClientPlugin } from './types';
import { ResourceMemoryPresets } from './settings/resource-memory-presets';
import { CONFIRM_DIALOG_SLOT, DIRECTORY_PICKER_SLOT } from '@/lib/plugin-host/slots';
import { ProductConfirmDialog } from '@/components/confirm-dialog/confirm-dialog';

// Loaded on demand (docs/BUNDLE-SIZE.md): only a folder request paints it.
const ProductDirectoryBrowser = dynamic(() => import('@/components/directory-browser').then((m) => m.ProductDirectoryBrowser), { ssr: false });

export const coreSettingsClient: BundledClientPlugin = {
  module: '@timon/settings',
  apply(ctx) {
    ctx.register({ slot: 'settings.resources' }, ResourceMemoryPresets);
    // Default occupant of `directory.picker` (a boot slot, TIM-0136): the folder
    // browser of the active machine's daemon, the route this module serves. A
    // plugin that takes the slot replaces it in Settings, projects and agents at
    // once; with the slot empty, each host still paints the product's browser.
    ctx.register({ slot: DIRECTORY_PICKER_SLOT, fallback: true }, ProductDirectoryBrowser);
    // Default occupant of `confirm.dialog` (a boot slot, TODO #781): every
    // confirmation of the app. Not loaded on demand: the host in the root
    // layout already imports it, for the empty slot.
    ctx.register({ slot: CONFIRM_DIALOG_SLOT, fallback: true }, ProductConfirmDialog);
  },
};
