'use client';

import { useEffect, useState } from 'react';
import { fetchPendingCommandRequests, type PendingByProject } from '@/lib/command-requests';
import { sseOn } from '@/lib/sse-stream';

const POLL_MS = 30_000;
const EMPTY: PendingByProject = { total: 0, projects: [] };

/**
 * Command requests waiting for the user, by project. The daemon raises a
 * notification with each request and dismisses it with the decision, so
 * `notifications_changed` is the signal to re-read; the slow poll covers a
 * dropped stream and a notifications module that is off (no signal at all).
 */
export function usePendingCommandRequests(): PendingByProject {
  const [pending, setPending] = useState<PendingByProject>(EMPTY);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const next = await fetchPendingCommandRequests();
        if (alive) setPending(next);
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

  return pending;
}
