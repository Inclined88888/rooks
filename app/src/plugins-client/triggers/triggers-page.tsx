'use client';

import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { isModuleOn, useCapabilities } from '@/lib/capabilities';
import { t } from '@/lib/i18n';
import { RoutinesClient } from '../routines/routines-page';
import { availableTabs, isTriggerTab, tabFromSearch, TRIGGERS_MODULE, type TriggerTab } from './model';
import { TriggerList } from './trigger-list';

export { TRIGGERS_MODULE };
export const ROUTINES_MODULE = '@rooks/routines';

function writeTab(tab: TriggerTab): void {
  const url = new URL(window.location.href);
  url.searchParams.set('tab', tab);
  window.history.replaceState(null, '', url.toString());
}

/** Webhooks: the daemon is reachable from this machine only, and says so. */
function LoopbackNotice(): React.ReactElement {
  return (
    <div role="note" className="mt-3 rounded-lg border border-border bg-muted/30 px-4 py-3 text-[12px] leading-relaxed text-muted-foreground">
      <p>{t('triggersPage.loopback.body')}</p>
      <p className="mt-1">{t('triggersPage.loopback.none')}</p>
    </div>
  );
}

function RoutinesTab({ routines, triggers }: { routines: boolean; triggers: boolean }): React.ReactElement {
  return (
    <>
      {routines && <RoutinesClient />}
      {triggers && (
        <section className={routines ? 'mt-8' : undefined}>
          <h2 className="text-[14px] font-semibold">{t('triggersPage.scheduleTriggers')}</h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{t('triggersPage.scheduleTriggersHint')}</p>
          <TriggerList source="schedule" excludeRoutines />
        </section>
      )}
    </>
  );
}

/**
 * Triggers page (TODO #216): a source runs actions. One tab per source —
 * Routines (schedule, where the former Routines page now lives), Webhooks
 * and Events (the internal bus). The tab is kept in `?tab=` so a link can
 * open one directly, and `/routines` lands on the first.
 */
export function TriggersPage(): React.ReactElement {
  const caps = useCapabilities();
  const modules = { routines: isModuleOn(caps, ROUTINES_MODULE), triggers: isModuleOn(caps, TRIGGERS_MODULE) };
  const tabs = availableTabs(modules);
  const [asked, setAsked] = useState<TriggerTab | null>(() => (
    typeof window === 'undefined' ? null : tabFromSearch(window.location.search, tabs)
  ));
  // The modules can change under the page (caps loading, a module switched
  // off): a tab that is no longer shown falls back to the first one.
  const current = asked && tabs.includes(asked) ? asked : tabs[0] ?? null;

  function select(value: string) {
    if (!isTriggerTab(value)) return;
    setAsked(value);
    writeTab(value);
  }

  return (
    <div className="relative z-[1] h-full overflow-auto px-6 pb-8 pt-5">
      <h1 className="text-[22px] font-semibold -tracking-[0.01em]">{t('triggersPage.title')}</h1>
      <p className="mt-1 text-[13px] text-muted-foreground">{t('triggersPage.subtitle')}</p>
      {current && (
        <Tabs value={current} onValueChange={select} className="mt-4">
          <TabsList aria-label={t('triggersPage.tabsLabel')}>
            {tabs.map((tab) => (
              <TabsTrigger key={tab} value={tab}>{t(`triggersPage.tabs.${tab}`)}</TabsTrigger>
            ))}
          </TabsList>
          {tabs.map((tab) => (
            <TabsContent key={tab} value={tab}>
              <p className="text-[12px] text-muted-foreground">{t(`triggersPage.tabHints.${tab}`)}</p>
              {tab === 'routines' && <RoutinesTab routines={modules.routines} triggers={modules.triggers} />}
              {tab === 'webhooks' && <><LoopbackNotice /><TriggerList source="webhook" /></>}
              {tab === 'events' && <TriggerList source="event" />}
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}
