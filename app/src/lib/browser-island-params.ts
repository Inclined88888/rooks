import type { IslandParams } from '@/lib/island-tree';

const AGENT = /^[A-Za-z0-9._-]{1,128}$/;
const MISSION = /^[A-Za-z0-9-]{1,64}$/;

/** `{ agent, mission, display }`. A `profile` handed by a source is dropped: the daemon
 *  resolves it from the agent (`components/browser-island.tsx`). Kept apart from
 *  the island so registering it does not load the browser view. */
export function parseBrowserIslandParams(raw: unknown): IslandParams | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { agent, mission, display } = raw as Record<string, unknown>;
  if (typeof agent !== 'string' || !AGENT.test(agent) || agent === '.' || agent === '..') return null;
  return {
    agent,
    mission: typeof mission === 'string' && MISSION.test(mission) ? mission : null,
    display: display === 'mobile' || display === 'desktop' ? display : 'auto',
  };
}
