'use client';

import dynamic from 'next/dynamic';
import React, { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';
import type { BundledClientPlugin } from './types';
import { THEME_TOKENS_CSS } from './ui-theme-tokens';
import { useInitialAppearance, useInitialTheme } from '@/components/theme-provider';
import { pluginsSynced, subscribePluginSync } from '@/lib/plugin-host/loader';
import { useWorkspaceLayout } from '@/components/workspace-layout-provider';
import { loadLayout } from '@/lib/ui-layout-store';
import { APPEARANCE_SCOPE, APPEARANCE_EVENT, readNativeAppearance, appearanceCss, type NativeAppearance } from './ui-theme-variants';

// Loaded on demand (docs/BUNDLE-SIZE.md): statically imported, every page of the app paid for it.
const AppearanceSettings = dynamic(() => import('./ui-theme-appearance').then((m) => m.AppearanceSettings), { ssr: false });

/** Stable id so a claiming theme can target the same node, and tests can find it. */
export const THEME_TOKENS_STYLE_ID = 'rooks-theme-tokens';

export const UI_THEME_MODULE = '@rooks/ui-theme';

/** Re-exported: the palette used to live here, and tests import it from here. */
export { THEME_TOKENS_CSS };

const notSyncedOnServer = (): boolean => false;

/**
 * Default occupant of the `theme` slot. The `<style>` is deliberately NOT in
 * a cascade layer: it must beat the floor the shell paints
 * (`plugin-host/theme-floor.tsx`), exactly as a third-party theme claiming
 * the slot will beat this one.
 *
 * While the page expects ANOTHER theme (the built-in Rooks one, or a chosen
 * plugin) and the plugins are not synced yet, it paints nothing: its palette,
 * with the installation's accent, would beat the floor for the time the
 * expected theme's bundle takes to load, and the onboarding flashed the old
 * colours before Rooks's. The floor carries the same tokens meanwhile (and
 * Rooks's, `ThemeFloor`). Once synced, a theme that claimed the slot has
 * replaced this occupant; one that never came leaves it to paint.
 */
export function ThemeRoot(): ReactElement | null {
  const expected = useInitialTheme();
  const synced = useSyncExternalStore(subscribePluginSync, pluginsSynced, notSyncedOnServer);
  const { owner } = useWorkspaceLayout();
  const initialAppearance = useInitialAppearance();
  const [appearance, setAppearance] = useState<NativeAppearance>(initialAppearance);
  useEffect(() => {
    let alive = true;
    let changed = false;
    if (owner) void loadLayout({ scope: APPEARANCE_SCOPE, storage: null }).then((out) => {
      if (alive && !changed && out.ok) setAppearance(readNativeAppearance(out.raw));
    });
    const onChange = (event: Event) => { changed = true; setAppearance(readNativeAppearance((event as CustomEvent).detail)); };
    window.addEventListener(APPEARANCE_EVENT, onChange);
    return () => { alive = false; window.removeEventListener(APPEARANCE_EVENT, onChange); };
  }, [owner]);
  if (!synced && expected !== null && expected !== UI_THEME_MODULE) return null;
  return (
    <style
      id={THEME_TOKENS_STYLE_ID}
      dangerouslySetInnerHTML={{ __html: THEME_TOKENS_CSS + appearanceCss(appearance) }}
    />
  );
}

export const uiThemeClient: BundledClientPlugin = {
  module: UI_THEME_MODULE,
  apply(ctx) {
    ctx.register({ slot: 'theme', fallback: true }, ThemeRoot);
    // Own Settings category (T.7). Theme first: a missing `settings.section`
    // (blank layout that never declared it) must not cost the palette.
    ctx.register({ slot: 'settings.section' }, AppearanceSettings);
  },
};
