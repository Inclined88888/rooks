'use client';

import { ISLAND_ICON_TERMINAL } from '@/lib/island-tab-icons';
import { SquareTerminal } from 'lucide-react';
import { t } from '@/lib/i18n';
import {
  TERMINAL_ISLAND_KEY,
  killTerminalOfTab,
  newTerminalTab,
  parseTerminalIslandParams,
} from '@/lib/terminal-island-params';
import { registerNavItem } from './nav';
import { registerPage } from './page';
import type { BundledClientPlugin } from './types';
import dynamic from 'next/dynamic';

// Loaded on demand: statically imported, it weighed on every page of the app.
const TerminalPage = dynamic(() => import('./terminal-web/terminal-page').then((m) => m.TerminalPage), { ssr: false });
// Same for the island's view: it loads with the first terminal tab.
const TerminalIsland = dynamic(() => import('@/components/terminal/terminal-island').then((m) => m.TerminalIsland), { ssr: false });

/** Client half of `@timon/terminal-web`: the `/terminal` page and its nav entry,
 *  and a session as a content of the island workspace.
 *  "Open the terminal" is `TerminalOpener`, mounted by the root layout: it puts
 *  a session in the workspace of the view, as a popup. */
export const terminalWebClient: BundledClientPlugin = {
  module: '@timon/terminal-web',
  apply(ctx) {
    registerNavItem(ctx, { href: '/terminal', labelKey: 'nav.terminal', icon: SquareTerminal, order: 230, zone: 'nav.terminal' });
    registerPage(ctx, { route: '/terminal', Component: TerminalPage });
    // Same slot, same contract as a third-party content: no privilege (§5).
    ctx.register({
      slot: 'island.content',
      key: TERMINAL_ISLAND_KEY,
      island: {
        title: t('terminal.title'),
        icon: ISLAND_ICON_TERMINAL,
        parseParams: parseTerminalIslandParams,
        params: {
          sessionId: { type: 'string', maxLength: 128, description: 'Id of a live terminal session of the user, such as one already open in their workspace (islands_get). Omit it with `fresh`.' },
          scope: { type: 'string', nullable: true, maxLength: 210, description: 'Scope key the session is filed under: `project:<slug>` or `agent:<name>`.' },
          fresh: { type: 'boolean', description: 'Start a new shell when the user applies the layout, instead of showing an open session (then omit `sessionId`).' },
        },
        volatileParams: ['sessionId', 'fresh'],
        // One view per session: a pty has one size, two views would fight over it.
        singletonBy: 'sessionId',
        minWidth: 320,
        // The scope's shells share one island: a new one lands beside the others.
        groupBy: 'scope',
        newTab: newTerminalTab,
        onClose: killTerminalOfTab,
      },
    }, TerminalIsland);
  },
};
