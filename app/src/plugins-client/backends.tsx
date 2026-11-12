'use client';

import dynamic from 'next/dynamic';
import { ProductModelPicker } from '@/components/model-picker';
import { ProductProviderCliCards } from '@/components/provider-cli/provider-cli-cards';
import { MODEL_PICKER_SLOT, PROVIDER_CLI_SLOT } from '@/lib/plugin-host/slots';
import type { BundledClientPlugin } from './types';

// Loaded on demand (docs/BUNDLE-SIZE.md): statically imported, every page of the app paid for it.
const BackendsSettings = dynamic(() => import('./backends/backends-settings').then((m) => m.BackendsSettings), { ssr: false });

export const coreBackendsClient: BundledClientPlugin = {
  module: '@rooks/backends',
  apply(ctx) {
    // Own Settings category: the list of user-added backends and its form.
    ctx.register({ slot: 'settings.section' }, BackendsSettings);
    // Default occupant of `model.picker` (a boot slot): the selector of every
    // model field. A core module, so it is never switched off; a plugin that
    // takes the slot replaces it on every surface at once.
    ctx.register({ slot: MODEL_PICKER_SLOT, fallback: true }, ProductModelPicker);
    // Default occupant of `providers.cli` (a boot slot): the provider cards of the onboarding
    // and of Settings › AI models. A plugin that takes the slot replaces them on every screen.
    ctx.register({ slot: PROVIDER_CLI_SLOT, fallback: true }, ProductProviderCliCards);
  },
};
