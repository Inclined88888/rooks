'use client';

import { useSyncExternalStore } from 'react';
import { GLASS_EVENT } from '@/plugins-client/ui-theme-variants';
import type { WidgetLayout } from './widget-layout';

/**
 * The style every widget starts from, set once for the whole site in Settings →
 * Appearance and mirrored on `<html>` (`applyGlassAttributes`). `at` is when it
 * last changed: a widget's own choice, made from its menu, wins over the site's
 * only if it is newer — so switching the site's style restyles every widget at
 * once, on every page, and a choice made afterwards sticks.
 */
export type WidgetStyleDefaults = { borderless: boolean; transparent: boolean; at: number };

function subscribe(onChange: () => void): () => void {
  window.addEventListener(GLASS_EVENT, onChange);
  return () => window.removeEventListener(GLASS_EVENT, onChange);
}
const root = () => document.documentElement;
const borderless = () => root().hasAttribute('data-widgets-borderless');
const transparent = () => root().hasAttribute('data-widgets-transparent');
const styleAt = () => Number(root().getAttribute('data-widgets-style-at')) || 0;

export function useWidgetStyleDefaults(): WidgetStyleDefaults {
  const b = useSyncExternalStore(subscribe, borderless, () => false);
  const t = useSyncExternalStore(subscribe, transparent, () => false);
  const at = useSyncExternalStore(subscribe, styleAt, () => 0);
  return { borderless: b, transparent: t, at };
}

/** What is in effect for one widget: its own choice if it counts, else the site's.
 *  Before the site style was ever changed (`at` is 0), every choice counts: the
 *  screen looks as it did. */
export function effectiveWidgetStyle(entree: Pick<WidgetLayout, 'borderless' | 'transparent' | 'borderlessAt' | 'transparentAt'>, site: WidgetStyleDefaults) {
  const counts = (at: number | undefined) => site.at === 0 || (at ?? 0) > site.at;
  const borderlessOwn = entree.borderless !== undefined && counts(entree.borderlessAt);
  const transparentOwn = entree.transparent !== undefined && counts(entree.transparentAt);
  return {
    borderless: borderlessOwn ? entree.borderless === true : site.borderless,
    transparent: transparentOwn ? entree.transparent === true : site.transparent,
    /** The widget has a choice of its own that is in effect. */
    own: borderlessOwn || transparentOwn,
  };
}
