'use client';

import { Blocks } from 'lucide-react';
import { registerNavItem } from './nav';
import type { BundledClientPlugin } from './types';

/** The local gallery lists what `@rooks/plugins` serves on `/api/plugins`. */
export const corePluginsClient: BundledClientPlugin = {
  module: '@rooks/plugins',
  apply(ctx) {
    registerNavItem(ctx, { href: '/plugins', labelKey: 'nav.plugins', icon: Blocks, order: 270 });
  },
};
