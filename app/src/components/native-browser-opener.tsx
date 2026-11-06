'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { BROWSER_PANEL_CONTEXT, BROWSER_PANEL_CONTEXT_QUERY, BROWSER_PANEL_OPEN, BROWSER_PANEL_QUERY, BROWSER_PANEL_TOGGLE, publishBrowserPanelState, type BrowserMissionContext } from '@/lib/browser-panel-bus';
import { activateIslandTab, closeIslandTab, islandTabOf, openInIsland, useIslandBus } from '@/lib/island-bus';
import type { IslandContent } from '@/lib/island-tree';

/** The browser as a content of the island workspace (`components/browser-island.tsx` registers it). */
export const BROWSER_ISLAND_KEY = 'view';
export const BROWSER_ISLAND_TYPE = `@timon/browser-embedded:${BROWSER_ISLAND_KEY}`;

/**
 * "Open the browser", mounted once at the root of the app. The browser has no
 * window any more: it is an island (`browser-island.tsx`), one per agent — a
 * profile has one native view and one control lease. The toggles of the chat
 * and the nav rail (`browser-panel-bus.ts`) land here: the first opens it as a
 * popup over the page, the next one closes it.
 */
export function NativeBrowserPanel() {
  const pathname = usePathname();
  const params = useSearchParams();
  const agent = params.get('agent') || '';
  const [chatContext, setChatContext] = useState<BrowserMissionContext | null>(null);
  const mission = params.get('mission') || (chatContext?.agent === agent ? chatContext.missionId : null);
  const bus = useIslandBus();
  const islandTab = agent ? islandTabOf(bus, BROWSER_ISLAND_TYPE, (p) => p.agent === agent) : null;
  const tabRef = useRef(islandTab);
  tabRef.current = islandTab;
  const contentRef = useRef<IslandContent | null>(null);
  contentRef.current = pathname === '/chat' && agent
    ? { type: BROWSER_ISLAND_TYPE, params: { agent, mission, display: 'auto' } }
    : null;
  useEffect(() => {
    const context = (event: Event) => setChatContext((event as CustomEvent<BrowserMissionContext>).detail);
    window.addEventListener(BROWSER_PANEL_CONTEXT, context);
    window.dispatchEvent(new CustomEvent(BROWSER_PANEL_CONTEXT_QUERY));
    return () => window.removeEventListener(BROWSER_PANEL_CONTEXT, context);
  }, []);
  useEffect(() => {
    const show = () => {
      const tab = tabRef.current;
      if (tab) activateIslandTab(tab.id);
      else if (contentRef.current) openInIsland(contentRef.current, { edge: 'float' });
    };
    const toggle = () => {
      const tab = tabRef.current;
      if (tab) closeIslandTab(tab.id);
      else show();
    };
    const query = () => publishBrowserPanelState(!!tabRef.current);
    window.addEventListener(BROWSER_PANEL_TOGGLE, toggle);
    window.addEventListener(BROWSER_PANEL_QUERY, query);
    window.addEventListener(BROWSER_PANEL_OPEN, show);
    return () => {
      window.removeEventListener(BROWSER_PANEL_TOGGLE, toggle);
      window.removeEventListener(BROWSER_PANEL_QUERY, query);
      window.removeEventListener(BROWSER_PANEL_OPEN, show);
    };
  }, []);
  useEffect(() => { publishBrowserPanelState(!!islandTab); }, [islandTab]);
  return null;
}
