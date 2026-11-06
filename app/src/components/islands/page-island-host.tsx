'use client';

/**
 * A page outside `AppFrame` as host of the island workspace
 * (`docs/ISLAND-WORKSPACE.md` §1, step 6): `/events`, `/notifications`,
 * `/agents`, `/projects`, `/multichat`. These pages paint their own TopBar,
 * `fixed` over a full-height column, and offset their body by
 * `--timon-nav-w` and `--timon-topbar-h`. The TopBar stays outside; the body
 * is the route's island.
 *
 * Alone, the workspace is layout-neutral (`display: contents`): the body is
 * still a child of the page's column and paints exactly what it did. Split,
 * the container takes the column's room and keeps its islands under the top
 * bar and right of the nav rail, with the chrome's gutter around them — the
 * place `AppFrame` gives its own island.
 */

import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { IslandWorkspace, useIslandWorkspacePainted } from './island-workspace';

/** `flex-1` in a page column (`/events`), `h-full` in a plain block (`/agents`). */
export const PAGE_ISLAND_SPLIT_CLASS =
  'relative h-full min-h-0 min-w-0 flex-1 pb-[var(--timon-island-gap)] pl-[var(--timon-nav-w)] pr-[var(--timon-island-gap)] pt-[var(--timon-topbar-h)]';

export function PageIslandHost({ children }: { children: ReactNode }): ReactElement {
  return <IslandWorkspace className="contents" splitClassName={PAGE_ISLAND_SPLIT_CLASS} route={children} />;
}

/**
 * The root of a page body that lets the document scroll while it is alone
 * (`/notifications`). In an island the document no longer scrolls for it — the
 * island clips — so it scrolls itself; alone, nothing changes.
 */
export function PageIslandBody({ className, children }: { className?: string; children: ReactNode }): ReactElement {
  const painted = useIslandWorkspacePainted();
  return <div className={cn(className, painted && 'overflow-y-auto')}>{children}</div>;
}
