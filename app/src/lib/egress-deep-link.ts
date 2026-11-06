'use client';

/**
 * `/chat?mission=<id>&egress=1`, where a new-host alert leads
 * (`notification-href.ts`): opens the mission's Network view beside the chat.
 *
 * Only once the workspace is announced (an open before its arrangement is read
 * would be dropped), only if `@timon/missions` holds the content type (a layout
 * may have turned the module off), and once per mission: a later rerender, or
 * the user closing the tab, does not bring it back.
 */

import { useEffect, useRef } from 'react';
import { openInIsland, useIslandBus } from './island-bus';
import { useSlotEntries } from './plugin-host/render';
import { EGRESS_ISLAND_KEY, egressIslandContent } from './egress';

export const EGRESS_MODULE = '@timon/missions';

export function useEgressDeepLink(missionId: string | null, requested: boolean): void {
  const bus = useIslandBus();
  const entries = useSlotEntries('island.content');
  const registered = entries.some((entry) => entry.pluginId === EGRESS_MODULE && entry.key === EGRESS_ISLAND_KEY);
  const opened = useRef<string | null>(null);

  useEffect(() => {
    if (!requested || !missionId || !registered || !bus.present) return;
    if (opened.current === missionId) return;
    if (openInIsland(egressIslandContent(missionId), { edge: bus.narrow ? 'center' : 'right' })) opened.current = missionId;
  }, [requested, missionId, registered, bus.present, bus.narrow]);
}
