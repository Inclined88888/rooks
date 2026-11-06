'use client';

import { GlassClear } from '@/components/glass-scope';

/**
 * Turns a full-bleed page into an island: a rounded rectangle of the page's
 * own colour, with the chrome colour around it on the right and at the bottom.
 *
 * For pages that paint themselves edge to edge (chat, multichat…) and do not
 * go through `AppFrame`. It is a layer, not a wrapper: placed as the FIRST
 * child of a `relative overflow-hidden` container, under the content, its
 * shadow paints the chrome outside the rounded rectangle and the container
 * clips the rest. The page's layout is untouched. The left edge sits on the
 * nav rail, whose corners `ChromeCorners` already paints.
 */
export function IslandUnderlay(): React.ReactElement {
  return (
    <div
      aria-hidden
      // A hook for the content's own CSS (`[data-island-underlay]~…`), which must keep clear of the inset.
      data-island-underlay=""
      className="timon-island-underlay pointer-events-none absolute bottom-[var(--timon-island-gap)] left-[var(--timon-nav-w)] right-[var(--timon-island-gap)] top-0 hidden rounded-[var(--timon-island-radius)] shadow-[0_0_0_100vmax_var(--timon-chrome-fill)] md:block"
    >
      {/* Glass, widgets scope: the island is clear and shows the wallpaper itself. */}
      <GlassClear />
    </div>
  );
}
