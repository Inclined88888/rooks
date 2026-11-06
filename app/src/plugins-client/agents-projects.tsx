'use client';

import dynamic from 'next/dynamic';
import { isPageSurfaceAllowed } from '@/lib/capabilities';
import type { BundledClientPlugin } from './types';

// Loaded on demand (docs/BUNDLE-SIZE.md): statically imported, every page of the app paid for it.
const AgentsGridClient = dynamic(() => import('@/app/agents-grid/agents-grid-client').then((m) => m.AgentsGridClient), { ssr: false });

/** The project view has its own switch in the plugin catalog. */
export const agentsProjectsClient: BundledClientPlugin = {
  module: '@timon/agents-projects',
  apply(ctx) {
    if (!isPageSurfaceAllowed(ctx.caps, '/agents')) return;
    ctx.register({ slot: 'agents.view', key: 'projects' }, AgentsGridClient);
  },
};
