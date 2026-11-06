'use client';

import { useEffect, type ReactElement } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { ProductAppCard } from '@/components/app-card/app-card';
import { t } from '@/lib/i18n';
import { MCP_FEATURED_SLOT } from '@/lib/mcp-tab-context';
import { APP_CARD_SLOT } from '@/lib/plugin-host/slots';
import { registerPage } from './page';
import type { BundledClientPlugin } from './types';

// Loaded on demand (docs/BUNDLE-SIZE.md): statically imported, every page of the app paid for it.
const ConnectorsSection = dynamic(() => import('./mcp-apps/connectors-section').then((m) => m.ConnectorsSection), { ssr: false });

/**
 * `/apps` was the catalogue's own page; the catalogue now heads the MCP tab of
 * Capabilities. The route stays because the daemon's closed list of OAuth
 * return paths names it, and an old link may too: it forwards the consent's
 * outcome (`oauth`, `id`, `error`) to the tab, which announces it.
 */
function AppsRedirect(): ReactElement {
  const router = useRouter();
  useEffect(() => {
    const from = new URL(window.location.href).searchParams;
    const to = new URLSearchParams({ tab: 'mcp' });
    for (const key of ['oauth', 'id', 'error']) {
      const v = from.get(key);
      if (v !== null) to.set(key, v);
    }
    router.replace(`/capabilities?${to.toString()}`);
  }, [router]);
  return <div className="p-7 text-sm text-muted-foreground">{t('common.loading')}</div>;
}

export const mcpAppsClient: BundledClientPlugin = {
  module: '@timon/mcp-apps',
  apply(ctx) {
    // Default occupant of `apps.card` (a boot slot): a plugin that takes the
    // slot replaces every card of the section at once.
    ctx.register({ slot: APP_CARD_SLOT, fallback: true }, ProductAppCard);
    // The official connectors open the MCP tab, before the user's own servers.
    ctx.register({ slot: MCP_FEATURED_SLOT, order: 10 }, ConnectorsSection);
    registerPage(ctx, { route: '/apps', Component: AppsRedirect });
  },
};
