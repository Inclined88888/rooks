'use client';

import { useEffect } from 'react';
import { buildIslandSnapshot } from '@/lib/island-proposals';
import type { IslandContentType } from './island-content';

export const ISLAND_SNAPSHOT_ENDPOINT = '/api/ui/islands/snapshot';

/** What this document last handed over, per account: unchanged types are not sent again. */
const published = new Map<string, string>();

/**
 * Hands the daemon what only this browser knows — the registered content
 * types, their titles and declared params — so an agent's `islands_get` can
 * list them and its `islands_propose` be checked against them. Debounced:
 * plugins register one by one after the first paint.
 */
export function usePublishIslandSnapshot(owner: string | null, types: ReadonlyMap<string, IslandContentType>): void {
  useEffect(() => {
    if (!owner) return;
    const timer = setTimeout(() => {
      const text = JSON.stringify(buildIslandSnapshot(types.values()));
      if (published.get(owner) === text) return;
      void fetch(ISLAND_SNAPSHOT_ENDPOINT, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: text })
        .then((r) => { if (r.ok) published.set(owner, text); })
        // An older daemon, or one that is restarting: the next change publishes again.
        .catch(() => {});
    }, 1500);
    return () => clearTimeout(timer);
  }, [owner, types]);
}
