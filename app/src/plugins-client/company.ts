'use client';

import { apply } from './company/client';
import { isPageSurfaceAllowed } from '@/lib/capabilities';
import type { BundledClientPlugin } from './types';

export const companyClient: BundledClientPlugin = {
  module: '@rooks/company',
  apply(ctx) {
    if (!isPageSurfaceAllowed(ctx.caps, '/agents')) return;
    // Hidden by default for the 12/09/2026 beta: the org chart isn't a story
    // we can tell yet, and an unfinished view costs more than an absent one.
    // The module keeps running and its data are untouched — only its surfaces
    // are withheld. Bringing them back is one line of `rooks.config.json`:
    // `modules: { "@rooks/company": { "ui": true } }`. A licence freezes the
    // module composition but not its options, so this is the only switch that
    // reaches the browser here.
    if (ctx.options.ui !== true) return;
    ctx.onDispose(apply({ slots: { register: ctx.register } }));
  },
};
