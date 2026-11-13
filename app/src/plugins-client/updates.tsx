'use client';

import { ProductUpdateBanner } from '@/components/updates/update-banner';
import { UPDATES_BANNER_SLOT } from '@/lib/plugin-host/slots';
import { UPDATES_MODULE } from '@/lib/updates';
import type { BundledClientPlugin } from './types';

/**
 * Client half of `@rooks/updates`: the "new version" banner, as the default
 * occupant of its boot slot. A plugin's replacement keeps the slot; the host
 * (`UpdateBannerHost`, in the top bar) decides whether there is a version to show.
 */
export const updatesClient: BundledClientPlugin = {
  module: UPDATES_MODULE,
  apply(ctx) {
    ctx.register({ slot: UPDATES_BANNER_SLOT, fallback: true }, ProductUpdateBanner);
  },
};
