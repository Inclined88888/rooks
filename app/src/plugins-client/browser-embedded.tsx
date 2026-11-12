'use client';

import { ISLAND_ICON_BROWSER } from '@/lib/island-tab-icons';
import { t } from '@/lib/i18n';
import dynamic from 'next/dynamic';
import { BROWSER_ISLAND_KEY } from '@/components/native-browser-opener';
import { parseBrowserIslandParams } from '@/lib/browser-island-params';
import type { BundledClientPlugin } from './types';

/** The view (remote surface, credentials, prompts) loads when a browser tab
 *  first shows, not with the root layout (docs/BUNDLE-SIZE.md). */
const BrowserIsland = dynamic(() => import('@/components/browser-island').then((m) => m.BrowserIsland), { ssr: false });

/** Client half of `@rooks/browser-embedded`: the browser as a content of the
 *  island workspace. "Open the browser" (`NativeBrowserPanel`, mounted by the
 *  root layout) opens it as a popup; it has no window of its own. */
export const browserEmbeddedClient: BundledClientPlugin = {
  module: '@rooks/browser-embedded',
  apply(ctx) {
    // Same slot, same contract as a third-party content: no privilege (§5).
    ctx.register({
      slot: 'island.content',
      key: BROWSER_ISLAND_KEY,
      island: {
        title: t('browserPanel.aria.embeddedBrowser'),
        icon: ISLAND_ICON_BROWSER,
        parseParams: parseBrowserIslandParams,
        // Published to the daemon, which checks an agent's proposal against
        // it: undeclared, a proposal without `agent` passed there and was
        // refused only on the user's card.
        params: {
          agent: { type: 'string', required: true, maxLength: 128, description: 'Name of the agent whose built-in browser opens (letters, digits, `.`, `_`, `-`). Its profile follows from the agent; no param chooses one.' },
          mission: { type: 'string', nullable: true, maxLength: 64, description: 'Mission whose browser profile to show (letters, digits, `-`); null for the agent\'s own profile.' },
          display: { type: 'string', enum: ['auto', 'mobile', 'desktop'], description: 'Viewport the page renders at; `auto` follows the island\'s width.' },
        },
        volatileParams: ['mission'],
        // One native view and one control lease per agent's browser.
        singletonBy: 'agent',
        minWidth: 320,
      },
    }, BrowserIsland);
  },
};
