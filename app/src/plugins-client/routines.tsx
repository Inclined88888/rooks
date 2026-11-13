'use client';

import { isModuleOn } from '@/lib/capabilities';
import { registerTriggersSurfaces } from './triggers';
import { TRIGGERS_MODULE } from './triggers/model';
import type { BundledClientPlugin } from './types';

/**
 * The Routines page became the Routines tab of the Triggers page, which
 * `@rooks/triggers` registers. This half only stands in when that module is
 * off — a Free licence minted before it existed runs routines without it —
 * so the routines keep a page. Never while capabilities are unknown: both
 * halves would claim the same keys.
 */
export const routinesClient: BundledClientPlugin = {
  module: '@rooks/routines',
  apply(ctx) {
    if (!ctx.caps || isModuleOn(ctx.caps, TRIGGERS_MODULE)) return;
    registerTriggersSurfaces(ctx, 'nav.routines');
  },
};
