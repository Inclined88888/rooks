'use client';

import dynamic from 'next/dynamic';
import { registerPage } from './page';
import type { BundledClientPlugin } from './types';

// Loaded on demand: statically imported, it weighed on every page of the app.
const MemoryClient = dynamic(() => import('./memory/memory-page').then((m) => m.MemoryClient), { ssr: false });

export const memoryClient: BundledClientPlugin = {
  module: '@timon/memory',
  apply(ctx) {
    registerPage(ctx, { route: '/memory', Component: MemoryClient });
  },
};
