'use client';

import dynamic from 'next/dynamic';
import { PanelsTopLeft } from 'lucide-react';
import { NavLink } from '@/components/nav-link';
import { ARRANGEMENT_ROUTE, arrangementHref } from '@/lib/island-arrangements';
import { arrangementsState, followAccountArrangements, subscribeArrangements } from '@/lib/island-arrangements-store';
import type { BundledClientContext } from './types';

const IslandArrangementPage = dynamic(() => import('@/components/islands/island-arrangement-page').then((m) => m.IslandArrangementPage), { ssr: false });

/** In the main group, after the product's own pages and before the divider. */
export const ARRANGEMENT_NAV_ORDER = 150;

/**
 * The named island arrangements as surfaces of the layout plugin: one page,
 * keyed `/islands/*`, and one `nav.item` per arrangement the person put in
 * the menu, keyed by its address — so each entry is ordered and hidden like
 * any other page of the menu (`lib/nav-order.ts`, `lib/nav-hidden.ts`).
 *
 * The list is the account's and arrives after `apply`, so entries are
 * registered as it changes (the pattern of `agent-chat.tsx`). No capability
 * check: the page only ever shows the account's own arrangement, and what
 * its islands hold keeps its own permissions — the same footing as
 * `/profile`.
 */
export function registerIslandArrangements(ctx: BundledClientContext): void {
  ctx.register({ slot: 'page', key: `${ARRANGEMENT_ROUTE}/*` }, IslandArrangementPage);

  // The name is baked into the registration: a rename registers it again,
  // under the same key, hence at the same place in the menu.
  const entries = new Map<string, { name: string; dispose: () => void }>();
  let alive = true;
  ctx.onDispose(() => { alive = false; });
  const sync = (): void => {
    if (!alive) return;
    const shown = arrangementsState().arrangements.filter((a) => a.menu);
    for (const arrangement of shown) {
      const entry = entries.get(arrangement.id);
      if (entry?.name === arrangement.name) continue;
      entry?.dispose();
      const href = arrangementHref(arrangement.id);
      const { name } = arrangement;
      entries.set(arrangement.id, {
        name,
        dispose: ctx.register({ slot: 'nav.item', key: href, order: ARRANGEMENT_NAV_ORDER }, function ArrangementNavItem() {
          return <NavLink href={href} label={name} icon={PanelsTopLeft} />;
        }),
      });
    }
    for (const [id, entry] of [...entries]) {
      if (shown.some((a) => a.id === id)) continue;
      entry.dispose();
      entries.delete(id);
    }
  };
  ctx.onDispose(subscribeArrangements(sync));
  ctx.onDispose(followAccountArrangements());
  sync();
}
