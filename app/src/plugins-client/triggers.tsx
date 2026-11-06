'use client';

import dynamic from 'next/dynamic';
import { Zap } from 'lucide-react';
import { NavLink } from '@/components/nav-link';
import { isNavSurfaceAllowed, isPageSurfaceAllowed, isPluginSurfaceAllowed } from '@/lib/capabilities';
import type { BundledClientContext, BundledClientPlugin } from './types';
import { LEGACY_ROUTINES_ROUTE, TRIGGERS_ROUTE } from './triggers/model';
import { RoutinesRedirect } from './triggers/redirect';

// Loaded on demand (docs/BUNDLE-SIZE.md): statically imported, every page of the app paid for it.
const TriggersPage = dynamic(() => import('./triggers/triggers-page').then((m) => m.TriggersPage), { ssr: false });

/**
 * Nav entry, page and the `/routines` redirect of the Triggers page. A grant
 * written for the former Routines page (`page:/routines`, `nav:routines`)
 * still opens it: the page is that one, renamed.
 */
export function registerTriggersSurfaces(ctx: BundledClientContext, zone: string): void {
  const pageAllowed = isPluginSurfaceAllowed(ctx.caps, ctx.id)
    || isPageSurfaceAllowed(ctx.caps, TRIGGERS_ROUTE)
    || isPageSurfaceAllowed(ctx.caps, LEGACY_ROUTINES_ROUTE);
  const navAllowed = pageAllowed
    || isNavSurfaceAllowed(ctx.caps, TRIGGERS_ROUTE, ctx.id)
    || isNavSurfaceAllowed(ctx.caps, LEGACY_ROUTINES_ROUTE);
  if (navAllowed && ctx.zoneVisible(zone)) {
    ctx.register({ slot: 'nav.item', key: TRIGGERS_ROUTE, order: 80 }, function TriggersNavItem() {
      return <NavLink href={TRIGGERS_ROUTE} labelKey="nav.triggers" icon={Zap} activeRoutes={[LEGACY_ROUTINES_ROUTE]} />;
    });
  }
  if (!pageAllowed) return;
  ctx.register({ slot: 'page', key: TRIGGERS_ROUTE }, TriggersPage);
  ctx.register({ slot: 'page', key: LEGACY_ROUTINES_ROUTE }, RoutinesRedirect);
}

export const triggersClient: BundledClientPlugin = {
  module: '@timon/triggers',
  apply(ctx) {
    registerTriggersSurfaces(ctx, 'nav.triggers');
  },
};
