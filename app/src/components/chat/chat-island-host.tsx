'use client';

/**
 * The chat page as host of the island workspace (`docs/ISLAND-WORKSPACE.md`
 * §1, step 7). The route's island is the chat's body, columns included: the
 * element `useChatRailsLayout` measures. Its columns therefore stay in the
 * chat's island and fold into panels when that island gets narrow — the
 * measured element is the island.
 *
 * Until something is opened next to the chat, the workspace is layout-neutral
 * (`display: contents`) and the chat paints exactly what it did.
 */

import type { ReactElement, ReactNode } from 'react';
import { IslandUnderlay } from '@/components/island-underlay';
import { IslandWorkspace, useIslandWorkspacePainted } from '@/components/islands/island-workspace';

/**
 * The chats of a view share ONE set of widget zones (`chat.left.widget`,
 * `chat.right.widget`): the primary chat of this group mounts them, the others
 * show their panels' triggers only (Q10). The chat page and every chat island
 * belong to it.
 */
export const CHAT_COLUMNS_EXCLUSIVE = 'chat.columns';

/**
 * A compact chat (a multichat cell) or one already in an island never hosts a
 * workspace: no recursion (§1).
 */
export function ChatIslandHost({ embedded, children }: { embedded: boolean; children: ReactNode }): ReactElement {
  if (embedded) return <>{children}</>;
  return (
    <IslandWorkspace
      routeExclusive={CHAT_COLUMNS_EXCLUSIVE}
      className="contents"
      // The chat paints edge to edge: the workspace keeps its islands off the
      // nav rail and the chrome's edges, as `IslandUnderlay` did.
      splitClassName="relative min-h-0 flex-1 pb-[var(--timon-island-gap)] pl-[var(--timon-nav-w)] pr-[var(--timon-island-gap)]"
      route={children}
    />
  );
}

/** The underlay stands in for an island while the chat is alone; islands paint their own. */
export function ChatIslandUnderlay(): ReactElement | null {
  return useIslandWorkspacePainted() ? null : <IslandUnderlay />;
}
