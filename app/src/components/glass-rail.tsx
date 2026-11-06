'use client';

import { useEffect, useState } from 'react';
import { BackgroundSurface, useOptionalBackground } from '@/components/background/background-provider';

/**
 * The frosted chrome where the nav rail unfolds over the page (glass, from `md`).
 *
 * The chrome is one layer under the whole page (`body::before`, globals.css),
 * so the top bar, the folded rail and the gutters are a single frosted L. The
 * rail unfolded on hover lies over an island, and a `backdrop-filter` there
 * would frost the island, not the wallpaper: a lighter band, cut off from the
 * top bar. So this strip paints its own copy of the wallpaper and frosts that.
 * Its mask makes it a backdrop root: the blur reads the copy only, over the
 * whole viewport, exactly as the layer under the page reads the wallpaper.
 * Same pixels on both sides of every edge, by construction.
 *
 * Its mask follows the rail's width at the rail's pace and carries the two
 * rounded corners of the island beside it (globals.css, `.timon-glass-rail`).
 */
export function GlassRail({ expanded }: { expanded: boolean }): React.ReactElement | null {
  const background = useOptionalBackground();
  const glass = useGlassAttribute();
  if (!glass || !background) return null;
  return (
    <div aria-hidden data-expanded={expanded ? '' : undefined} className="timon-glass-rail">
      <BackgroundSurface background={background} />
      <div className="timon-glass-rail-frost" />
    </div>
  );
}

/** `<html data-glass>`, live: the Appearance screen flips it without a reload. */
function useGlassAttribute(): boolean {
  const [glass, setGlass] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setGlass(root.hasAttribute('data-glass'));
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['data-glass'] });
    return () => observer.disconnect();
  }, []);
  return glass;
}
