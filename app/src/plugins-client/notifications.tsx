'use client';

import { isPageSurfaceAllowed } from '@/lib/capabilities';
import { t } from '@/lib/i18n';
import { BellWidget } from './notifications/bell-widget';
import type { BundledClientPlugin } from './types';
import { registerWidget } from './widget';
import { widgetPicto } from './widget-pictos';

/** The bell is ONE widget that takes the shape of its zone: the icon and its
 *  badge in a compact zone (the top bar's line, a sidebar), the dropdown's
 *  list as a card in a wide one (cockpit, chat column). It
 *  starts in the top bar (`placedByDefault`), where it always was, and Edit
 *  Layout moves it into a rail and back.
 *
 *  It replaces the former `inbox` card, which was the dropdown as a separate
 *  widget: two widgets for one feed. A layout that had placed that card keeps
 *  the place for the bell (`formerKeys`).
 *
 *  A viewer who cannot open the center gets neither the bell nor a link to a
 *  page that would refuse them. */
export const notificationsClient: BundledClientPlugin = {
  module: '@rooks/notifications',
  apply(ctx) {
    if (!isPageSurfaceAllowed(ctx.caps, '/notifications')) return;
    registerWidget(ctx, {
      key: 'bell',
      widget: {
        title: t('widgetCatalog.bell.title'), icon: widgetPicto('bell'), description: t('widgetCatalog.bell.description'),
        zone: 'topbar.widget',
        height: 320,
        minHeight: 160,
        frame: 'none',
        bar: true,
        placedByDefault: true,
        formerKeys: ['inbox'],
      },
      Component: BellWidget,
    });
  },
};
