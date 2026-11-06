'use client';

/**
 * A zone of widgets as a content of the island workspace
 * (`@timon/ui-layout:widget-zone`): drop cards into it and the island is a
 * page, no code.
 *
 * It is a real `WidgetZone` of the one `WidgetHost` (the layout root), keyed
 * by the tab's id (`island.<tabId>`) — stable across reloads, so the placements survive them. A
 * widget lives in exactly one zone, as everywhere else: dropping one here
 * takes it out of the cockpit. The slot is named `island.widget`: a slot whose
 * last segment is `widget` is a widget host (`slot-compat.ts`), so it
 * accepts any widget without a registration of its own.
 */

import { useEffect, type ReactElement } from 'react';
import { useIslandContent } from '@/components/islands/island-content';
import { WidgetZone } from '@/components/widget-host/widget-zone';
import { t } from '@/lib/i18n';
import type { IslandParams } from '@/lib/island-tree';

export const WIDGET_ZONE_KEY = 'widget-zone';
export const WIDGET_ZONE_SLOT = 'island.widget';

/** Takes no param: the zone is the tab itself. */
export function parseWidgetZoneParams(raw: unknown): IslandParams | null {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? {} : null;
}

/**
 * `island.<tabId>`: the daemon's zone id grammar (`widget-model.ts`) takes
 * letters, digits and `._#-` — a `:` would get the whole zone report of the
 * view refused. The tab id is sanitised the same way every time, so the id
 * stays stable; an agent reads it back from `widgets_get`.
 */
export function widgetZoneId(tabId: string): string {
  return `island.${tabId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80)}`;
}

export function WidgetZoneIsland(): ReactElement {
  const { tabId, setTitle } = useIslandContent();
  const label = t('islands.widgetZone.title');
  useEffect(() => { setTitle(label); }, [label, setTitle]);
  return (
    <WidgetZone
      zone={widgetZoneId(tabId)}
      slot={WIDGET_ZONE_SLOT}
      label={label}
      className="flex h-full min-h-0 flex-col gap-2 overflow-auto p-2"
    />
  );
}
