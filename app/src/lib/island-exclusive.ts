/**
 * Contents that must not live twice at once (`docs/ISLAND-WORKSPACE.md` §7,
 * Q10). Two chats would each declare the chat's widget zones and paint the
 * same cards twice: duplicate dnd-kit ids, cards bound to one chat's context
 * or the other's. A type that says so (`IslandContentOptions.exclusive`) has
 * ONE primary instance in the workspace; the others show a stand-in.
 *
 * The workspace decides, not each content: two instances deciding on their own
 * effects would both claim the zones for a commit.
 */

import type { IslandId, TabId } from './island-tree';

export type ExclusiveCandidate = {
  tabId: TabId;
  leafId: IslandId;
  /** The route's page (`host:route`), when the host says it takes part. */
  route: boolean;
};

/**
 * The primary instance among the MOUNTED, visible candidates of one group:
 * - the one in the focused island — clicking into an island makes it active;
 * - else the previous primary, while it is still a candidate: focusing a
 *   terminal must not take the columns away from every chat;
 * - else the route's page;
 * - else the first candidate, in the order of the tree.
 */
export function exclusiveOwner(
  candidates: readonly ExclusiveCandidate[],
  focus: IslandId | null,
  previous: TabId | null,
): TabId | null {
  const focused = candidates.find((c) => c.leafId === focus);
  if (focused) return focused.tabId;
  if (previous !== null && candidates.some((c) => c.tabId === previous)) return previous;
  return (candidates.find((c) => c.route) ?? candidates[0])?.tabId ?? null;
}
