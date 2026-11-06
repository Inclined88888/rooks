'use client';

/**
 * Catch-all route: the door plugin pages come through.
 *
 * Next only reaches this file for a path it serves no page for, which is
 * exactly what makes the `page` slot safe to key by route — a plugin can
 * never shadow `/settings` or `/kanban`, since those never get here. Product
 * pages stay Next routes until they are extracted, one at a time.
 *
 * Rendered as the Next tree, so it lands in the slot under the reserved key
 * and paints inside the layout like any other page.
 *
 * The paint decision itself lives in `route-view.tsx`, kept out of this file
 * because a page file may only export `default`/`metadata`/… — a named
 * export here fails the generated `.next/types/.../page.ts` contract.
 */

import { useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { pluginsSynced, subscribePluginSync } from '@/lib/plugin-host/loader';
import { useCapabilities } from '@/lib/capabilities';
import { PluginRoutePageView } from './route-view';

function serverSnapshot(): boolean { return false; }

export default function PluginRoutePage(): React.ReactElement {
  const pathname = usePathname() ?? '';
  const synced = useSyncExternalStore(subscribePluginSync, pluginsSynced, serverSnapshot);
  const caps = useCapabilities();
  return <PluginRoutePageView pathname={pathname} synced={synced} caps={caps} />;
}
