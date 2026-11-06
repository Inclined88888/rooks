'use client';

/**
 * Activity: what the agents did, said and cost, in one place.
 *
 * Missions, Inbox, Memory and Stats are read after the fact and rarely, so
 * they share one nav entry and a strip of horizontal tabs instead of four rows
 * of the rail. Each tab is the view its own route still serves (`/missions`,
 * `/messages`, `/memory`, `/dashboard`): links that point there keep working.
 */

import { useCallback, type ComponentType, type ReactElement } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { t } from '@/lib/i18n';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

// Loaded on demand: statically imported, it weighed on every page of the app.
const MissionsClient = dynamic(() => import('@/app/(main)/missions/missions-client').then((m) => m.MissionsClient), { ssr: false });
const MessagesClient = dynamic(() => import('@/app/(main)/messages/messages-client').then((m) => m.MessagesClient), { ssr: false });
const DashboardClient = dynamic(() => import('@/app/(main)/dashboard/dashboard-client').then((m) => m.DashboardClient), { ssr: false });
const MemoryClient = dynamic(() => import('../memory/memory-page').then((m) => m.MemoryClient), { ssr: false });

export type ActivityTabId = 'missions' | 'inbox' | 'memory' | 'stats';

/** Display order: the two read most often first, the rarest last. */
export const ACTIVITY_TABS: readonly { id: ActivityTabId; labelKey: string }[] = [
  { id: 'missions', labelKey: 'nav.missions' },
  { id: 'inbox', labelKey: 'nav.inbox' },
  { id: 'memory', labelKey: 'nav.memory' },
  { id: 'stats', labelKey: 'nav.stats' },
];

/** Routes whose view lives in a tab, so the nav entry stays lit on them. */
export const ACTIVITY_ROUTES = ['/missions', '/messages', '/memory', '/dashboard'] as const;

function MissionsTab(): ReactElement {
  return (
    <div className="relative z-[1] h-full overflow-auto px-6 pb-8 pt-5">
      <MissionsClient />
    </div>
  );
}

function InboxTab(): ReactElement {
  const agent = useSearchParams().get('agent') ?? undefined;
  return <MessagesClient initialAgent={agent} />;
}

const TAB_VIEWS: Readonly<Record<ActivityTabId, ComponentType>> = {
  missions: MissionsTab,
  inbox: InboxTab,
  memory: MemoryClient,
  stats: DashboardClient,
};

export function ActivityPage({ tabs }: { tabs: readonly ActivityTabId[] }): ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requested = searchParams.get('tab');
  const active = tabs.find((id) => id === requested) ?? tabs[0];

  const select = useCallback((id: ActivityTabId) => {
    // Only the tab changes: `?agent=` and friends belong to the view inside.
    const next = new URLSearchParams(searchParams.toString());
    next.set('tab', id);
    router.replace(`/activity?${next.toString()}`, { scroll: false });
  }, [router, searchParams]);

  if (!active) return <div className="p-7 text-sm text-muted-foreground">{t('common.loading')}</div>;
  const View = TAB_VIEWS[active];

  return (
    <Tabs value={active} onValueChange={(id) => select(id as ActivityTabId)} className="relative z-[1] flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-6 pb-3 pt-4">
        <TabsList aria-label={t('nav.activity')}>
          {ACTIVITY_TABS.filter((tab) => tabs.includes(tab.id)).map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>{t(tab.labelKey)}</TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value={active} className="mt-0 min-h-0 flex-1">
        <View />
      </TabsContent>
    </Tabs>
  );
}
