'use client';

import { useEffect } from 'react';
import { buildWidgetSnapshot, type SnapshotZone } from '@/lib/widget-proposals';
import type { EntreeCatalogue } from './widget-catalog';

export const WIDGET_SNAPSHOT_ENDPOINT = '/api/ui/widgets/snapshot';

/** What this document last handed over, per account: an unchanged catalog is not sent again. */
const published = new Map<string, string>();

/**
 * Hands the daemon what only this browser knows — widget titles, compact
 * forms, the starters of each view, the zones the page mounts — so an agent's
 * `widgets_get` can name them and its `widgets_propose` be checked against
 * them. Debounced: plugins register one by one after the first paint, and the
 * catalog settles a moment later.
 */
export function usePublishWidgetSnapshot(input: {
  owner: string | null;
  entries: readonly EntreeCatalogue[];
  visible: (id: string) => boolean;
  view: string | null;
  zones: readonly SnapshotZone[];
}): void {
  const { owner, entries, visible, view, zones } = input;
  useEffect(() => {
    if (!owner || entries.length === 0) return;
    const timer = setTimeout(() => {
      const text = JSON.stringify(buildWidgetSnapshot({ entries, visible, view, zones }));
      if (published.get(owner) === text) return;
      void fetch(WIDGET_SNAPSHOT_ENDPOINT, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: text })
        .then((r) => { if (r.ok) published.set(owner, text); })
        // An older daemon, or one that is restarting: the next change publishes again.
        .catch(() => {});
    }, 1500);
    return () => clearTimeout(timer);
  }, [owner, entries, visible, view, zones]);
}
