'use client';

import { useEffect, useState } from 'react';
import { sseOn } from '@/lib/sse-stream';

const POLL_MS = 20_000;

/**
 * Number of active (not dismissed) notifications — the figure the notification
 * center itself calls `total_active`, every kind included: the rail's badge
 * belongs to the center, which lists them all. The bell's badge is not this
 * one — it counts the kinds its dropdown shows (`useNotificationFeed`).
 * Refreshed on the `notifications_changed`
 * event, with a slow poll as a safety net for a dropped stream.
 */
export function useActiveNotificationCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const r = await fetch('/api/ui/notifications?limit=1', { cache: 'no-store' });
        if (!r.ok || !alive) return;
        const j = (await r.json()) as { total_active?: number };
        if (alive) setCount(j.total_active ?? 0);
      } catch { /* keep the last known value */ }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    const unsub = sseOn('notifications_changed', () => void refresh());
    return () => {
      alive = false;
      clearInterval(timer);
      unsub();
    };
  }, []);

  return count;
}
