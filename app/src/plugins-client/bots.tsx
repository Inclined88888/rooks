'use client';

import { Bot } from 'lucide-react';
import { registerNavItem } from './nav';
import { registerPage } from './page';
import { registerWidget } from './widget';
import { widgetPicto } from './widget-pictos';
import dynamic from 'next/dynamic';
import { t } from '@/lib/i18n';
import type { BundledClientPlugin } from './types';
import { BOTS_RAIL_KEY } from './bots/bots-islands';

// Loaded on demand: statically imported, it weighed on every page of the app.
const BotsPage = dynamic(() => import('./bots/bots-page').then((m) => m.BotsPage), { ssr: false });
const BotsRailWidget = dynamic(() => import('./bots/bots-rail-widget').then((m) => m.BotsRailWidget), { ssr: false });

/**
 * `/bots` — the view for someone who will never create a project: their
 * project-less bots in a left island, grouped by team, and the chat of the
 * one they picked in the route's island. A plugin of its own rather than a
 * fourth tab of `/agents`, so it can be taken away without touching the
 * project views.
 */
export const botsClient: BundledClientPlugin = {
  module: '@rooks/bots',
  apply(ctx) {
    // Between Agents (30) and Multichat (40): same family, read before them
    // by the audience this view is for.
    // The module switch in `/plugins` takes both entries away; the zone
    // lets `ui.hidden` drop the nav item alone.
    registerNavItem(ctx, { href: '/bots', labelKey: 'nav.bots', icon: Bot, order: 35, zone: 'nav.bots' });
    // A page, not a set of panes: clicking the list or the chat rings
    // neither, and the chat's island has no tab bar.
    registerPage(ctx, { route: '/bots', Component: BotsPage, options: { focusRing: false, bareRoute: true } });
    // The rail is a widget: `/bots` shows it in an island of its own, and it
    // can be dropped on any view, where a pick opens the bot's chat there.
    registerWidget(ctx, {
      key: BOTS_RAIL_KEY,
      widget: {
        title: t('widgetCatalog.botsRail.title'),
        icon: widgetPicto('botsRail'),
        description: t('widgetCatalog.botsRail.description'),
        height: 420,
        heightMode: 'fill',
        minHeight: 200,
        frame: 'none',
        // `/bots` is built around the rail: its island there has no header to
        // move, fold or close it.
        bareIslandOn: ['/bots'],
      },
      Component: BotsRailWidget,
    });
  },
};
