'use client';

/**
 * What the chat page's conversation is opened on, read in the route's island.
 *
 * In a split view, the page's panel keeps a conversation of another agent
 * picked in its rail (TIM-0140): kept in the route tab's params with the view
 * it was picked on, it is what the panel shows when the view comes back, and
 * what its tab is titled after (`routeChatOfUrl`, read by the workspace too).
 * The view keeps its agent, so its tab in the top bar and its workspace stay
 * the same. Alone, the page still turns into the other agent's chat
 * (TODO #460): there is no view around it to keep anything in.
 */

import { useMemo, useRef } from 'react';
import { useIslandRouteTab } from '@/components/islands/island-workspace';
import { routeChatOfUrl, routeChatParams } from '@/lib/chat-island-params';
import { routeParams } from '@/lib/island-tree';

export type PageChat = {
  /** The page's address, its mission replaced by the one the panel keeps. */
  chatParams: URLSearchParams;
  /** `ChatClient.keepInView`; absent while nothing can be kept. */
  keepInView?: (missionId: string, owner: string) => boolean;
};

export function usePageChat(params: URLSearchParams): PageChat {
  const routeTab = useIslandRouteTab();
  const view = params.get('agent') ?? '';
  const keptMission = routeTab ? routeChatOfUrl(routeTab.tree, params)?.missionId ?? null : null;
  const chatParams = useMemo(() => {
    if (!keptMission || params.get('mission') === keptMission) return params;
    const next = new URLSearchParams(params.toString());
    next.set('mission', keptMission);
    next.delete('fresh');
    return next;
  }, [params, keptMission]);
  const treeRef = useRef(routeTab?.tree ?? null);
  treeRef.current = routeTab?.tree ?? null;
  const setRoute = routeTab?.setParams ?? null;
  const keepInView = useMemo(() => {
    if (!setRoute) return undefined;
    return (missionId: string, owner: string): boolean => {
      const next = routeChatParams(view, { agent: owner, missionId });
      const kept = next.view !== undefined;
      // The tree is the project's, shared by its agents' views: back on its
      // own agent, the page forgets what it kept for THIS view only.
      if (kept || (treeRef.current && routeParams(treeRef.current).view === view)) setRoute(next);
      return kept;
    };
  }, [setRoute, view]);
  return { chatParams, keepInView };
}
