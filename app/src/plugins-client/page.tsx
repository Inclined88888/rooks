'use client';

/**
 * Helper for a module registering its own route in the `page` slot.
 *
 * Same shape as `registerNavItem` / `registerWidget`: the module owns the
 * key (its route), and disposal is automatic when the module switches off —
 * the catch-all (`(main)/[...route]/page.tsx`) then paints "unknown route"
 * for it, exactly what it would show for a plugin nobody installed. No
 * `PAGE_MODULE` table, no `ModulePageGate`: a page that doesn't register
 * doesn't exist, the way it already works for every third-party plugin.
 */

import type { ComponentType } from 'react';
import type { PageOptions } from '@/lib/plugin-host/slots';
import { isPageSurfaceAllowed, isPluginSurfaceAllowed } from '@/lib/capabilities';
import type { BundledClientContext } from './types';

export type PageEntry = {
  /** Path this page answers, e.g. `/dreams`. Becomes the `page` slot key. */
  route: string;
  Component: ComponentType;
  /** How the island workspace paints this view (`PageOptions`). */
  options?: PageOptions;
};

export function registerPage(ctx: BundledClientContext, entry: PageEntry): void {
  if (!isPageSurfaceAllowed(ctx.caps, entry.route) && !isPluginSurfaceAllowed(ctx.caps, ctx.id)) return;
  ctx.register({ slot: 'page', key: entry.route, page: entry.options }, entry.Component);
}
