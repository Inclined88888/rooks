'use client';

/**
 * The rail of bots as a widget (`plugin:@timon/bots:rail`).
 *
 * On `/bots` it sits in an island of its own, beside the route's island that
 * holds the chat: a pick writes `?agent=` and the chat follows. Dropped on any
 * other view, a pick brings the bot's chat to that view (`routeBotPick`):
 * never a page change.
 */

import { useCallback, useContext, useMemo, type ReactElement } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { IslandContentContext } from '@/components/islands/island-content';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import { useActiveAgents } from '@/lib/active-agents';
import type { ActiveState } from '@/lib/agent-state';
import { activateIslandTab, openInIsland, useIslandBus } from '@/lib/island-bus';
import { cn } from '@/lib/utils';
import { BOTS_ROUTE, routeBotPick } from './bots-islands';
import { BotsRail } from './bots-rail';
import { useBots } from './use-bots';

export function useBotStates(): Map<string, ActiveState> {
  const active = useActiveAgents();
  return useMemo(() => {
    const map = new Map<string, ActiveState>();
    for (const agent of active) map.set(agent.name, agent.state);
    return map;
  }, [active]);
}

/** Picks a bot from wherever the rail is painted; `after` runs once the pick is routed (closing a drawer). */
export function useBotPick(after?: () => void): (name: string) => void {
  const router = useRouter();
  const pathname = usePathname();
  const bus = useIslandBus();
  const inIsland = useContext(IslandContentContext) !== null;
  return useCallback((name: string) => {
    const pick = routeBotPick({ agent: name, pathname, workspace: bus.present, tabs: bus.tabs, inIsland });
    const done = pick.kind === 'activate'
      ? (activateIslandTab(pick.tabId), true)
      : pick.kind === 'open' && openInIsland(pick.content, { edge: pick.edge });
    // `push`, not `replace`: on `/bots` picking a bot is a navigation the back
    // button undoes. A soft one: the view and its islands stay mounted. Also
    // the way out when the workspace refused to open the chat (island limit).
    if (!done) router.push(pick.kind === 'route' ? pick.href : `${BOTS_ROUTE}?agent=${encodeURIComponent(name)}`);
    after?.();
  }, [router, pathname, bus.present, bus.tabs, inIsland, after]);
}

export function BotsRailWidget({ poignee, className }: WidgetProps): ReactElement {
  const pathname = usePathname();
  const params = useSearchParams();
  const { bots, teams, refresh } = useBots();
  const states = useBotStates();
  const pick = useBotPick();
  // Only `/bots` names a selected bot: elsewhere the chats it opened are tabs.
  const selected = pathname === BOTS_ROUTE ? params.get('agent') : null;
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <BotsRail
        bots={bots}
        teams={teams}
        selected={selected}
        states={states}
        onSelect={pick}
        onChanged={refresh}
        headerActions={poignee}
      />
    </div>
  );
}
