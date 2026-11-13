'use client';

/**
 * The delegations of the open conversation — the missions this chat spawned
 * and whose return it is still waiting for.
 *
 * ONE owner of the fetch, on purpose: the chat page calls this hook once and
 * hands the result down (`ChatRailValue`), so the widget and the inline strip
 * paint the same list without racing each other on the network. A second
 * caller would be a second poller.
 *
 * Live, never polled: the daemon says the arrival (`mission_child_started`)
 * and the departure (`mission_complete`, `turn_complete` — a return is
 * enqueued at the end of a turn). Each of them is an INVALIDATION, not data:
 * an event re-reads the list rather than patching it, so a duplicate emit
 * costs one request and never a duplicate line.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { sseOn } from '@/lib/sse-stream';

export type Delegation = {
  id: string;
  agent_name: string;
  /** Epoch ms — the surfaces run their own second counter from it. */
  started_at: number;
  running: boolean;
  turn_active: boolean;
  task_id: string | null;
  task_title: string | null;
  excerpt: string;
};

export function useDelegations(missionId: string | null): Delegation[] {
  const [delegations, setDelegations] = useState<Delegation[]>([]);
  // Read by the SSE handlers, which must not be re-registered on every list
  // change: a `mission_complete` names a child, and knowing whether it is one
  // of ours is what avoids a refetch on every mission of the machine.
  const known = useRef<Set<string>>(new Set());

  const load = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/ui/missions/${encodeURIComponent(id)}/delegations`, { cache: 'no-store' });
      if (!r.ok) return;
      const j = (await r.json()) as { delegations?: Delegation[] };
      const list = j.delegations ?? [];
      known.current = new Set(list.map((d) => d.id));
      setDelegations(list);
    } catch {
      // A failed read leaves the previous list in place: an empty strip would
      // claim the delegations ended, which is exactly what we do not know.
    }
  }, []);

  useEffect(() => {
    if (!missionId) {
      known.current = new Set();
      setDelegations([]);
      return;
    }
    void load(missionId);
    const refetch = () => void load(missionId);
    const offStart = sseOn('mission_child_started', (ev) => {
      const data = parse(ev.data);
      if (data?.parentMissionId === missionId) refetch();
    });
    const onChild = (ev: MessageEvent) => {
      const data = parse(ev.data);
      if (data?.missionId && known.current.has(data.missionId)) refetch();
    };
    const offComplete = sseOn('mission_complete', onChild);
    const offTurn = sseOn('turn_complete', onChild);
    return () => { offStart(); offComplete(); offTurn(); };
  }, [missionId, load]);

  return delegations;
}

function parse(raw: string): { missionId?: string; parentMissionId?: string } | null {
  try {
    return JSON.parse(raw) as { missionId?: string; parentMissionId?: string };
  } catch {
    return null;
  }
}
