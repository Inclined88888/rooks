/**
 * `GET /api/ui/missions/latest?agent=` — the mission a chat opened without
 * `?mission=` binds. `null`: the agent has none. `undefined`: the lookup
 * failed (an older daemon without the route, a network error) — the caller
 * falls back to the mission list.
 */
export type LatestMission = { id: string; agent_name: string; running: boolean };

export async function fetchLatestMission(agent: string): Promise<LatestMission | null | undefined> {
  try {
    const r = await fetch(`/api/ui/missions/latest?${new URLSearchParams({ agent })}`, { cache: 'no-store' });
    if (!r.ok) return undefined;
    const body = (await r.json()) as { mission?: unknown };
    if (body.mission === null) return null;
    const m = body.mission as Partial<LatestMission> | undefined;
    return m && typeof m.id === 'string' ? (m as LatestMission) : undefined;
  } catch {
    return undefined;
  }
}
