'use client';

import { t } from '@/lib/i18n';
import { Brain } from 'lucide-react';
import { registerNavItem } from './nav';
import { registerPage } from './page';
import type { BundledClientPlugin } from './types';
import dynamic from 'next/dynamic';
import { registerWidget } from './widget';
import { widgetPicto } from './widget-pictos';

// Loaded on demand (docs/BUNDLE-SIZE.md): statically imported, every page of the app paid for it.
const CockpitVaultGraphTile = dynamic(() => import('./vault/cockpit-vault-graph-tile').then((m) => m.CockpitVaultGraphTile), { ssr: false });

// Loaded on demand: statically imported, it weighed on every page of the app.
const BrainPage = dynamic(() => import('./vault/page').then((m) => m.BrainPage), { ssr: false });

export const vaultClient: BundledClientPlugin = {
  module: '@timon/vault',
  apply(ctx) {
    registerNavItem(ctx, { href: '/brain', labelKey: 'nav.brain', icon: Brain, order: 20, zone: 'nav.brain' });
    registerPage(ctx, { route: '/brain', Component: BrainPage });
    // The only card of the product that lands in the right rail. The slot
    // cannot say it — both cockpit rails share `cockpit.widget` — hence the
    // zone declared by the registration, for the first placement only.
    registerWidget(ctx, {
      key: 'vault-graph',
      zone: 'cockpit.vault-graph',
      widget: { title: t('widgetCatalog.vault.title'), icon: widgetPicto('vault'), description: t('widgetCatalog.vault.description'), zone: 'droite', height: 420, minHeight: 200, frame: 'none' },
      Component: CockpitVaultGraphTile,
    });
  },
};
