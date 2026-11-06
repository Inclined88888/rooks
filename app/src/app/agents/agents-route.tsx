'use client';

/**
 * `/agents` — the constellation, and nothing else.
 *
 * This file used to be `agents-view-switcher.tsx`: one URL, a floating group
 * tab, and three views behind it (Canvas, Projects, Company). The tab is gone
 * — each entry point is its own route now, `/projects` for the grid, `/bots`
 * for the project-less bots — so this route has a single occupant again.
 *
 * Old links and bookmarks (`?view=grid`, `?view=projects`) are still served:
 * they land here and are sent on to `/projects`. `?view=company` is simply
 * ignored, that view being withheld for the beta (`@timon/company`, option
 * `ui`).
 */

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { TopBar } from '@/components/topbar';
import { PageIslandHost } from '@/components/islands/page-island-host';
import { AgentsClient } from './agents-client';
import { AgentsWidgetRails } from './agents-widget-rails';
import { normalizeAgentsView } from './view-mode';

export function AgentsRoute() {
  const params = useSearchParams();
  const router = useRouter();
  const requested = normalizeAgentsView(params.get('view'));

  useEffect(() => {
    // `replace`, not `push`: the migrated URL must not add a step that sends
    // the back button straight back to the link we just left.
    if (requested === 'projects') router.replace('/projects');
  }, [requested, router]);

  // The TopBar stays out of the workspace; the constellation and its rails
  // are the route's island, their `fixed` surfaces confined to it.
  return <div className="relative z-[1] h-[100dvh] overflow-hidden">
    <div className="fixed inset-x-0 top-0 z-[6]"><TopBar /></div>
    <PageIslandHost>
      <AgentsClient />
      <AgentsWidgetRails />
    </PageIslandHost>
  </div>;
}
