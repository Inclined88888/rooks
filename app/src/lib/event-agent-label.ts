/**
 * The agent column of the `/events` stream.
 *
 * The live events carry their mission, not their agent, and a recent event
 * whose mission was deleted comes back with `agent_name: null`. Both used to
 * be shown as `_main`: every live event looked like the main agent's, and the
 * label named an agent that no longer exists once onboarding renames it. The
 * agent is now read from the mission; a mission nobody can resolve shows its
 * short id, which is what the viewer can still look up.
 */

/** The agent of a mission, `null` when the daemon does not know it (deleted,
 *  or not visible to this viewer). Throws on a failure worth retrying. */
export type MissionAgentLookup = (missionId: string) => Promise<string | null>;

/** Keeps the stream from growing a map without end on a long-open tab. */
const CACHE_CAP = 1000;

export function eventAgentLabel(agentName: string | null | undefined, missionId: string | null | undefined): string {
  if (agentName) return agentName;
  if (missionId) return missionId.slice(0, 8);
  return '—';
}

export type MissionAgentResolver = {
  /** Records what the recent-events seed already told us. */
  remember(missionId: string, agentName: string | null): void;
  /** The label for `missionId`, looked up once per mission. */
  label(missionId: string): Promise<string>;
};

export function createMissionAgentResolver(lookup: MissionAgentLookup): MissionAgentResolver {
  const cache = new Map<string, Promise<string | null>>();
  const put = (missionId: string, value: Promise<string | null>) => {
    if (cache.size >= CACHE_CAP) cache.clear();
    cache.set(missionId, value);
  };
  return {
    remember(missionId, agentName) {
      put(missionId, Promise.resolve(agentName));
    },
    async label(missionId) {
      let pending = cache.get(missionId);
      if (!pending) {
        pending = lookup(missionId).catch(() => {
          // A network hiccup must not pin the short id on this mission for
          // the rest of the session: the next event asks again.
          cache.delete(missionId);
          return null;
        });
        put(missionId, pending);
      }
      return eventAgentLabel(await pending, missionId);
    },
  };
}

/** `lookup` over `/api/ui/missions/:id?view=status`, scoped to the viewer by
 *  the daemon like the stream itself. */
export async function fetchMissionAgent(missionId: string): Promise<string | null> {
  const res = await fetch(`/api/ui/missions/${encodeURIComponent(missionId)}?view=status`, { cache: 'no-store' });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`mission lookup failed: ${res.status}`);
  const body = (await res.json()) as { agent_name?: unknown };
  return typeof body.agent_name === 'string' && body.agent_name ? body.agent_name : null;
}
