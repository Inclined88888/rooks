/**
 * The `/bots` view as two islands: the rail of bots (a widget, shown in an
 * island of its own) and the chat of the picked bot (the route's island).
 *
 * Pure, so the seeded tree and the routing of a pick are testable without a
 * workspace mounted.
 */

import { CHAT_ISLAND_TYPE } from '@/lib/chat-island-params';
import { HOST_ROUTE, newIslandId, type IslandContent, type IslandLeaf, type IslandTab, type IslandTree, type TabId } from '@/lib/island-tree';

export const BOTS_MODULE = '@timon/bots';
export const BOTS_ROUTE = '/bots';
/** Registration key of the rail widget: its placement id is `plugin:@timon/bots:rail`. */
export const BOTS_RAIL_KEY = 'rail';
export const BOTS_RAIL_WIDGET = `plugin:${BOTS_MODULE}:${BOTS_RAIL_KEY}`;
/** `@timon/ui-layout:widget-card` (`components/islands/widget-card-island.tsx`), spelled here to stay pure. */
export const WIDGET_CARD_TYPE = '@timon/ui-layout:widget-card';
/** Share of the width the rail's island starts with: ~280 px on a 1280 px screen. */
export const BOTS_RAIL_RATIO = 0.22;

export function botsRailContent(): IslandContent {
  return { type: WIDGET_CARD_TYPE, params: { widget: BOTS_RAIL_WIDGET } };
}

/** Whether a tab of the workspace is the rail shown as an island. */
export function isBotsRailTab(content: IslandContent): boolean {
  return content.type === WIDGET_CARD_TYPE && content.params.widget === BOTS_RAIL_WIDGET;
}

function leafOf(content: IslandContent): IslandLeaf {
  const tab: IslandTab = { id: newIslandId(), content };
  return { id: newIslandId(), kind: 'leaf', tabs: [tab], active: tab.id };
}

/**
 * What `/bots` lays out when its view holds no arrangement: the rail on the
 * left, the chat (the route's own island) on the rest, the chat focused —
 * typing starts there.
 */
export function botsSeedTree(): IslandTree {
  const rail = leafOf(botsRailContent());
  const chat = leafOf({ type: HOST_ROUTE, params: {} });
  return {
    v: 1,
    root: { id: newIslandId(), kind: 'split', dir: 'row', children: [rail, chat], ratios: [BOTS_RAIL_RATIO, 1 - BOTS_RAIL_RATIO] },
    focus: chat.id,
  };
}

export type BotPick =
  /** On `/bots`: the route's island follows `?agent=`. */
  | { kind: 'route'; href: string }
  /** A chat of that bot is already open somewhere in the workspace. */
  | { kind: 'activate'; tabId: TabId }
  /** Open its chat: beside the rail when the rail is an island, else as a tab of the active island. */
  | { kind: 'open'; content: IslandContent; edge: 'right' | 'center' };

/**
 * Where a pick in the rail sends the user. Never a page change outside
 * `/bots`: the chat comes to the view the rail is on.
 */
export function routeBotPick(input: {
  agent: string;
  pathname: string;
  /** A workspace is mounted and ready to open contents. */
  workspace: boolean;
  /** The tabs of the workspace on screen. */
  tabs: readonly IslandTab[];
  /** The rail is itself painted inside an island content. */
  inIsland: boolean;
}): BotPick {
  const href = `${BOTS_ROUTE}?agent=${encodeURIComponent(input.agent)}`;
  if (input.pathname === BOTS_ROUTE || !input.workspace) return { kind: 'route', href };
  const open = input.tabs.find((tab) => tab.content.type === CHAT_ISLAND_TYPE && tab.content.params.agent === input.agent);
  if (open) return { kind: 'activate', tabId: open.id };
  return {
    kind: 'open',
    content: { type: CHAT_ISLAND_TYPE, params: { agent: input.agent, missionId: null, fresh: false } },
    // In an island, the active one is the rail's own: a tab there would hide the rail.
    edge: input.inIsland ? 'right' : 'center',
  };
}
