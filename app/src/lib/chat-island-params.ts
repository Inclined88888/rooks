/**
 * Params of `@timon/missions:chat` (`docs/ISLAND-WORKSPACE.md` §7), apart from
 * the chat itself: the drag sources (top bar, mission rail, multichat) need
 * them without pulling the chat page in — the top bar is part of it.
 */

import { EGRESS_DEEP_LINK_PARAM } from './egress';
import { allLeaves, routeParams, type IslandContent, type IslandParams, type IslandTree } from './island-tree';

export const CHAT_ISLAND_KEY = 'chat';
export const CHAT_ISLAND_TYPE = `@timon/missions:${CHAT_ISLAND_KEY}`;

// The daemon's own rule for an agent name (`agent-config.ts`).
const AGENT = /^[A-Za-z0-9._-]{1,128}$/;
const MISSION = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * `{ agent, missionId, fresh }`, always in this shape: the workspace tells an
 * already open chat by comparing params, and `{ agent }` must equal
 * `{ agent, missionId: null, fresh: false }`.
 */
export function parseChatIslandParams(raw: unknown): IslandParams | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { agent, missionId, fresh } = raw as Record<string, unknown>;
  if (typeof agent !== 'string' || !AGENT.test(agent)) return null;
  if (missionId !== undefined && missionId !== null && (typeof missionId !== 'string' || !MISSION.test(missionId))) return null;
  const mission = typeof missionId === 'string' ? missionId : null;
  // A fresh chat is one that has no mission yet.
  return { agent, missionId: mission, fresh: mission === null && fresh === true };
}

/**
 * The params a chat island takes once a conversation is on screen, `null`
 * when they already say so. The agent is the mission's owner, not the one the
 * tab was opened on: the rail lists the whole project (TODO #460), and a tab
 * kept on its first agent was titled after it while showing another agent's
 * chat, then reopened on the first agent (TIM-0140).
 */
export function chatIslandShown(
  current: { agent: string; missionId: string | null },
  missionId: string,
  owner: string,
): { agent: string; missionId: string; fresh: false } | null {
  const agent = AGENT.test(owner) ? owner : current.agent;
  if (current.agent === agent && current.missionId === missionId) return null;
  return { agent, missionId, fresh: false };
}

/**
 * The conversation the page's panel of a split chat view shows when it is not
 * the view's agent's (TIM-0140). The view is `/chat?agent=<view>`: the top
 * bar's tab of that agent, the workspace key. A mission of another agent
 * picked in the page's rail stays in that panel, kept in the route tab's
 * params with the view it was picked on, instead of turning the whole view
 * into the other agent's: the next return to the view finds it there.
 */
export type RouteChat = { agent: string; missionId: string };

/**
 * The route tab's params for `shown` on `view`; `{}` (nothing kept) when the
 * page shows the view's own agent, which the URL already says.
 */
export function routeChatParams(view: string, shown: RouteChat | null): IslandParams {
  if (!shown || shown.agent === view || !AGENT.test(view) || !AGENT.test(shown.agent) || !MISSION.test(shown.missionId)) return {};
  return { view, agent: shown.agent, missionId: shown.missionId };
}

/**
 * What the page's panel shows on `/chat?agent=<view>&mission=<urlMission>`,
 * `null` when the URL decides. The tree is shared by every agent of the
 * project (one `.islands` row per project): what was kept on one view is
 * never applied to another agent's. On its own view it wins over the URL's
 * mission when that mission is absent, the kept one, or already on screen in
 * another panel of the view: the top bar's tab of an agent names its running
 * conversation, which is the one beside. A link (`linked`: a highlight, a
 * network alert) or a conversation of the view nowhere on screen wins.
 */
export function routeChatOf(tree: IslandTree, view: string | null, urlMission: string | null, linked = false): RouteChat | null {
  if (!view) return null;
  const { view: keptView, agent, missionId } = routeParams(tree);
  if (keptView !== view || typeof agent !== 'string' || typeof missionId !== 'string') return null;
  const kept = { agent, missionId };
  if (!routeChatParams(view, kept).view) return null;
  if (!urlMission || urlMission === missionId) return kept;
  if (linked) return null;
  const beside = allLeaves(tree).some((leaf) => leaf.tabs.some((tab) => tab.content.type === CHAT_ISLAND_TYPE && tab.content.params.missionId === urlMission));
  return beside ? kept : null;
}

/**
 * `routeChatOf` for the page's address: one reading for the page's panel and
 * its tab's title, which must never disagree (TIM-0140). A new conversation
 * asked for (`?fresh=1`, no mission) decides, like a link.
 */
export function routeChatOfUrl(tree: IslandTree, params: Pick<URLSearchParams, 'get' | 'has'>): RouteChat | null {
  // A new conversation asked for (`newMissionHref`, the New picker of the
  // page's own chat): nothing kept stands in for it.
  if (params.get('fresh') === '1' && !params.get('mission')) return null;
  const linked = params.has('highlight') || params.get(EGRESS_DEEP_LINK_PARAM) === '1';
  return routeChatOf(tree, params.get('agent'), params.get('mission'), linked);
}

/** What a drag source or an "Open in a split" action hands the workspace. */
export function chatIslandContent(agent: string, missionId?: string | null): IslandContent {
  return { type: CHAT_ISLAND_TYPE, params: { agent, missionId: missionId || null, fresh: false } };
}

/** The `/chat` page on an agent, on one of its missions when given: what a link opens instead of an island. */
export function chatHref(agent: string, missionId?: string | null): string {
  const base = `/chat?agent=${encodeURIComponent(agent)}`;
  return missionId ? `${base}&mission=${encodeURIComponent(missionId)}` : base;
}

/** The `/chat` page on a mission whose agent the caller does not know: the page resolves it. */
export function chatMissionHref(missionId: string): string {
  return `/chat?mission=${encodeURIComponent(missionId)}`;
}
