'use client';

import { createContext, useContext, useSyncExternalStore, type ReactElement } from 'react';
import { BackgroundSurface, useOptionalBackground } from '@/components/background/background-provider';
import { DEFAULT_GLASS_SCOPE, GLASS_SCOPE_ATTRIBUTE, readGlassScope, resolveGlassScope, type GlassScope } from '@/lib/glass-scope';
import { GLASS_EVENT } from '@/plugins-client/ui-theme-variants';

/**
 * The glass scope an island of the workspace chose for itself, `null` when it
 * follows the account's default. Provided around each island's contents and
 * chassis (`island-workspace.tsx`); outside any island, `null`.
 */
const IslandGlassScopeContext = createContext<GlassScope | null>(null);
export const IslandGlassScopeProvider = IslandGlassScopeContext.Provider;

/** `<html>`'s glass, as one string: `off`, or the account's default scope. */
function readRoot(): 'off' | GlassScope {
  const root = document.documentElement;
  if (!root.hasAttribute('data-glass')) return 'off';
  return readGlassScope(root.getAttribute(GLASS_SCOPE_ATTRIBUTE)) ?? DEFAULT_GLASS_SCOPE;
}

/** The Appearance screen writes the attributes through `applyGlassAttributes`, which says so. */
function subscribe(onChange: () => void): () => void {
  window.addEventListener(GLASS_EVENT, onChange);
  return () => window.removeEventListener(GLASS_EVENT, onChange);
}

/**
 * Where the frosted glass sits for the component calling it: `island` (its
 * island is one frosted plate, a widget draws no blur of its own), `widgets`
 * (the island is clear, each widget is a frosted card), `both` (the frosted
 * plate, and each widget frosted again on top), or `null` while the
 * glass is off. The island's own choice wins over the account's default.
 * Exported to plugins by `@rooks/ui` (client API 15).
 */
export function useGlassScope(): GlassScope | null {
  const override = useContext(IslandGlassScopeContext);
  const root = useSyncExternalStore(subscribe, readRoot, () => 'off' as const);
  return root === 'off' ? null : resolveGlassScope(root, override);
}

/**
 * The island's own frost: a copy of the wallpaper and a layer that blurs and
 * tints it with the `island` zone's settings (`globals.css`,
 * `.rooks-glass-clear`). Every island frosts its own copy, so its blur owes
 * nothing to the chrome's frosted layer that runs under the whole page; the
 * `widgets` scope leaves the copy sharp. Fixed, so it lines up with the real
 * wallpaper; clipped to the island by its own wrapper. The parent must be
 * positioned and rounded. Without a wallpaper provider only the tint is laid.
 */
export function GlassClear(): ReactElement | null {
  const background = useOptionalBackground();
  const scope = useGlassScope();
  if (scope === null) return null;
  return (
    <div aria-hidden data-glass-clear="" className="rooks-glass-clear">
      {background && <div className="rooks-glass-clear-view"><BackgroundSurface background={background} /></div>}
      <div className="rooks-glass-clear-frost" />
    </div>
  );
}
