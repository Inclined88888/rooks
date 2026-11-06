'use client';

/**
 * Paint decision for the catch-all, split out of `page.tsx` so a test can
 * drive caps/synced without the Next router or a capabilities fetch — and
 * so App Router's page-file contract (only `default`/`metadata`/… allowed,
 * checked by the generated `.next/types/.../page.ts`) stays satisfied.
 *
 * Bundled modules fail-open while caps are still null (`isModuleOn`), so a
 * disabled page is already in the slot registry on a cold reload. Painting
 * that entry would flash its content for the length of `fetchCapabilities`.
 * Hold the loading fallback until capabilities have loaded once — the same
 * idea as `pluginsSynced` for third-party bundles.
 */

import React, { type ReactElement } from 'react';
import { PluginBoundary } from '@/lib/plugin-host/plugin-boundary';
import { useSlotEntry } from '@/lib/plugin-host/render';
import type { Capabilities } from '@/lib/capabilities';
import { t } from '@/lib/i18n';

function routeFallback(pathname: string, settled: boolean): ReactElement {
  return (
    <main className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
      {/* No entry yet can mean two things: the bundles are still loading,
          or nothing owns this path. Saying "unknown" before the loader has
          settled would flash a 404 on every plugin route. */}
      {settled ? t('route.unknown', { path: pathname }) : t('route.loading')}
    </main>
  );
}

export function PluginRoutePageView({
  pathname,
  synced,
  caps,
}: {
  pathname: string;
  synced: boolean;
  caps: Capabilities | null;
}): ReactElement {
  const exact = useSlotEntry('page', pathname);
  const wildcard = useSlotEntry('page', `/${pathname.split('/').filter(Boolean)[0] ?? ''}/*`);
  if (caps === null) return routeFallback(pathname, false);
  const entry = exact ?? wildcard;
  if (entry) {
    const Component = entry.Component;
    return <PluginBoundary pluginId={entry.pluginId}><Component /></PluginBoundary>;
  }
  return routeFallback(pathname, synced);
}
