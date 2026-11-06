'use client';

import { t } from '@/lib/i18n';
import { ISLAND_ICON_WIDGET_CARD, ISLAND_ICON_WIDGET_ZONE } from '@/lib/island-tab-icons';
import {
  parseWidgetCardParams,
  WIDGET_CARD_KEY,
  widgetCardBare,
  WidgetCardIsland,
} from '@/components/islands/widget-card-island';
import {
  parseWidgetZoneParams,
  WIDGET_ZONE_KEY,
  WidgetZoneIsland,
} from '@/components/islands/widget-zone-island';
import type { BundledClientPlugin } from './types';

/** Client half of `@timon/ui-layout`'s island contents: a catalog widget, or a zone of widgets, as an island. */
export const widgetCardIslandClient: BundledClientPlugin = {
  module: '@timon/ui-layout',
  apply(ctx) {
    ctx.register({
      slot: 'island.content',
      key: WIDGET_CARD_KEY,
      island: {
        title: t('islands.widgetCard.title'),
        icon: ISLAND_ICON_WIDGET_CARD,
        parseParams: parseWidgetCardParams,
        params: {
          widget: {
            type: 'string',
            required: true,
            maxLength: 200,
            description: 'Placement id of a widget, as widgets_get lists them (e.g. "plugin:@timon/missions:Missions").',
          },
        },
        // One tab per widget: opening it again focuses it.
        singletonBy: ['widget'],
        bare: widgetCardBare,
        minWidth: 240,
      },
    }, WidgetCardIsland);
    // A zone to drop widgets into: a page assembled by hand or by an agent, no code.
    ctx.register({
      slot: 'island.content',
      key: WIDGET_ZONE_KEY,
      island: {
        title: t('islands.widgetZone.title'),
        icon: ISLAND_ICON_WIDGET_ZONE,
        parseParams: parseWidgetZoneParams,
        params: {},
        minWidth: 240,
      },
    }, WidgetZoneIsland);
  },
};
