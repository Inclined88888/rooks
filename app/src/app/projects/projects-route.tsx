'use client';

/**
 * `/projects` — the project grid, on its own route.
 *
 * It used to be a tab of `/agents`, reached through a floating toggle. Three
 * doors now answer "where are my agents" (the constellation, this grid,
 * `/bots`), and a group tab above one of them made the other two look like
 * second-class citizens. Each door stands on its own URL, and the nav points
 * at it directly.
 *
 * The chassis is still the one of `/agents` — hexagonal background, TopBar
 * (which carries the vertical nav), Notifications and Tasks rails: that part
 * is the cockpit, not the view. Only the middle changes.
 *
 * The grid itself stays an occupant of the `agents.view` slot, registered by
 * `@rooks/agents-projects`: switching that module off must still take the
 * surface away, and this page must then say so rather than paint a hole.
 */

import Link from 'next/link';
import { FolderKanban } from 'lucide-react';
import { TopBar } from '@/components/topbar';
import { PageIslandHost } from '@/components/islands/page-island-host';
import { SlotKeyed } from '@/lib/plugin-host/render';
import { t } from '@/lib/i18n';
import { AgentsWidgetRails } from '@/app/agents/agents-widget-rails';

export function ProjectsRoute(): React.ReactElement {
  return <div className="relative z-[1] h-[100dvh] overflow-hidden">
    <div className="fixed inset-x-0 top-0 z-[6]"><TopBar /></div>
    {/* Same chassis as `/agents`: the TopBar out of the workspace, the grid and its rails in. */}
    <PageIslandHost>
      <SlotKeyed name="agents.view" entryKey="projects" fallback={<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
        <FolderKanban className="size-8 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t('nav.projects')}</h1>
        <p className="max-w-sm text-sm text-muted-foreground">{t('projectsRoute.unavailable')}</p>
        <Link href="/plugins?q=Projects" className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground">{t('agentsLayout.managePlugins')}</Link>
      </div>} />
      <AgentsWidgetRails />
    </PageIslandHost>
  </div>;
}
