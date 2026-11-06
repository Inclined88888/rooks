'use client';

import { t } from '@/lib/i18n';
import { Sparkles } from 'lucide-react';
import { registerNavItem } from './nav';
import dynamic from 'next/dynamic';
import type { BundledClientPlugin } from './types';
import { registerPage } from './page';
import { registerWidget } from './widget';
import { widgetPicto } from './widget-pictos';

// Loaded on demand (docs/BUNDLE-SIZE.md): statically imported, every page of the app paid for it.
const CockpitDreamsTile = dynamic(() => import('./dreams/cockpit-dreams-tile').then((m) => m.CockpitDreamsTile), { ssr: false });

// Loaded on demand: statically imported, it weighed on every page of the app.
const DreamsClient = dynamic(() => import('./dreams/dreams-page').then((m) => m.DreamsClient), { ssr: false });

export const dreamsClient: BundledClientPlugin = {
  module: '@timon/dreams',
  apply(ctx) {
    // Withdrawn from the beta on 12/09/2026, like `@timon/company` and through
    // the same lever: the surfaces are held back as long as the `ui` option is
    // not explicitly true. The module keeps its data and its routes; the
    // nightly pass is cut on the same key on the daemon side (otherwise we
    // would burn credits every night for proposals nobody can read any more).
    if (ctx.options.ui !== true) return;
    registerNavItem(ctx, { href: '/dreams', labelKey: 'nav.dreams', icon: Sparkles, order: 100, zone: 'nav.dreams' });
    registerWidget(ctx, {
      key: 'dreams',
      zone: 'cockpit.dreams',
      widget: { title: t('widgetCatalog.dreams.title'), icon: widgetPicto('dreams'), description: t('widgetCatalog.dreams.description'), height: 220, minHeight: 120, frame: 'none' },
      Component: CockpitDreamsTile,
    });
    registerPage(ctx, { route: '/dreams', Component: DreamsClient });
  },
};
