'use client';

/**
 * Helper for a module registering a main-nav entry.
 *
 * The zone check is kept identical to the hard-coded list it replaces: a
 * zone hidden in `timon.config.json` (editorial choice) or whose module is
 * off (technical) simply never registers. Ordering is explicit — see
 * `RegisterOptions.order`.
 */

import type { LucideIcon } from 'lucide-react';
import { NavLink } from '@/components/nav-link';
import { isNavSurfaceAllowed } from '@/lib/capabilities';
import type { BundledClientContext } from './types';

/**
 * Rank where the secondary group starts — what used to be the "More"
 * dropdown, then the block under the divider. Entries keep their own
 * numbers; only the boundary is shared.
 */
export const NAV_SECONDARY_ORDER = 200;

export type NavEntry = {
  href: string;
  labelKey: string;
  icon: LucideIcon;
  order: number;
  /** Zone id (plan §3.6). Absent = only `ui.hidden` can take it away. */
  zone?: string;
  /** Extra routes that light this entry (a route with no menu entry of its own). */
  activeRoutes?: readonly string[];
};

/** Label key of each registered entry, by route: what the island workspace names the route's tab. */
const labelKeys = new Map<string, string>();

/** Label key of the nav entry for `pathname` (longest matching route), or `null`. */
export function navLabelKeyOf(pathname: string): string | null {
  let best: string | null = null;
  for (const href of labelKeys.keys()) {
    const match = href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
    if (match && (!best || href.length > best.length)) best = href;
  }
  return best ? labelKeys.get(best) ?? null : null;
}

export function registerNavItem(ctx: BundledClientContext, entry: NavEntry): void {
  if (entry.zone && !ctx.zoneVisible(entry.zone)) return;
  if (!isNavSurfaceAllowed(ctx.caps, entry.href, ctx.id)) return;
  const { href, labelKey, icon, activeRoutes } = entry;
  labelKeys.set(href, labelKey);
  ctx.register(
    // `key` is the path: what a person's menu order refers to (`lib/nav-order.ts`).
    { slot: 'nav.item', key: href, order: entry.order },
    function ModuleNavItem() {
      return <NavLink href={href} labelKey={labelKey} icon={icon} activeRoutes={activeRoutes} />;
    },
  );
}
