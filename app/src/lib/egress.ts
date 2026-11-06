/**
 * A mission's outbound connections, as `GET /api/missions/:id/egress` returns
 * them (TODO #590, T3), and the island content that shows them
 * (`@timon/missions:egress`, T4). Kept apart from the view so the chat page can
 * open the content without pulling the view in.
 */

import type { IslandContent, IslandParams } from './island-tree';

export type EgressConnection = {
  id: number;
  method: string;
  host: string;
  port: number;
  status: number;
  bytes_out: number;
  bytes_in: number;
  started_at: number;
  duration_ms: number;
  error: string | null;
};

export type EgressHost = {
  host: string;
  connections: number;
  bytes_out: number;
  bytes_in: number;
  first_at: number;
  last_at: number;
  failures: number;
};

export type EgressProxyState = { mode: 'log' | 'off'; listening: boolean };

export type MissionEgress = {
  mission_id: string;
  connections: EgressConnection[];
  has_more: boolean;
  next_before: number | null;
  hosts: EgressHost[];
  new_hosts: Array<{ host: string; first_seen_at: number }>;
  retention: { per_mission: number; max_age_ms: number };
  /** Absent from a daemon older than T4: the view then says nothing about the proxy. */
  proxy?: EgressProxyState;
};

/** Why a read failed, in the words the view picks its message from. */
export type EgressFailure = 'unauthorized' | 'forbidden' | 'not_found' | 'unavailable';

export type EgressRead = { ok: true; data: MissionEgress } | { ok: false; failure: EgressFailure };

export const EGRESS_PAGE_SIZE = 100;

export function egressFailure(status: number): EgressFailure {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  return 'unavailable';
}

/** One page of the journal; `before` is the `next_before` of the previous page. */
export async function fetchMissionEgress(missionId: string, before?: number | null, signal?: AbortSignal): Promise<EgressRead> {
  const query = new URLSearchParams({ limit: String(EGRESS_PAGE_SIZE) });
  if (before) query.set('before', String(before));
  let res: Response;
  try {
    res = await fetch(`/api/ui/missions/${encodeURIComponent(missionId)}/egress?${query}`, { cache: 'no-store', signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    return { ok: false, failure: 'unavailable' };
  }
  if (!res.ok) return { ok: false, failure: egressFailure(res.status) };
  try {
    return { ok: true, data: (await res.json()) as MissionEgress };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

/** Hosts first learnt by this mission for its project, the ones the alert named. */
export function newHostSet(data: Pick<MissionEgress, 'new_hosts'>): Set<string> {
  return new Set(data.new_hosts.map((h) => h.host));
}

/** New hosts first, then the busiest: what a reader checks after an alert. */
export function orderHosts(hosts: readonly EgressHost[], fresh: ReadonlySet<string>): EgressHost[] {
  return [...hosts].sort((a, b) => Number(fresh.has(b.host)) - Number(fresh.has(a.host)) || b.last_at - a.last_at || a.host.localeCompare(b.host));
}

/** `120 ms`, `3.4 s`, then the running-tool bar's reading. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.floor(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

/** A connection that did not get through: an upstream error, or a refusal status. */
export function connectionFailed(c: Pick<EgressConnection, 'status' | 'error'>): boolean {
  return c.error !== null || c.status === 0 || c.status >= 400;
}

export const EGRESS_ISLAND_KEY = 'egress';
export const EGRESS_ISLAND_TYPE = `@timon/missions:${EGRESS_ISLAND_KEY}`;

// Same rule as a mission of `@timon/missions:chat` (`chat-island-params.ts`).
const MISSION = /^[A-Za-z0-9_.:-]{1,128}$/;

export function parseEgressIslandParams(raw: unknown): IslandParams | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { missionId } = raw as Record<string, unknown>;
  if (typeof missionId !== 'string' || !MISSION.test(missionId)) return null;
  return { missionId };
}

export function egressIslandContent(missionId: string): IslandContent {
  return { type: EGRESS_ISLAND_TYPE, params: { missionId } };
}

/** `?egress=1` on `/chat`: where the new-host alert leads (`notification-href.ts`). */
export const EGRESS_DEEP_LINK_PARAM = 'egress';
