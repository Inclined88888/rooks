'use client';

/**
 * Capabilities: what an agent can be given — skills (instruction files) and
 * MCP servers / connectors (tools) — as two tabs of **one** nav entry.
 * Customize / Skills / Connectors are never duplicated in the side menu:
 * Skills + Connectors live here; Customize is appearance / menu chrome only.
 * Deep links `/skills` and `/mcp` still work as tab aliases.
 */

import { useCallback, type ReactElement } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { t } from '@/lib/i18n';

// Loaded on demand: statically imported, it weighed on every page of the app.
const SkillsClient = dynamic(() => import('@/app/(main)/skills/skills-client').then((m) => m.SkillsClient), { ssr: false });
const McpClient = dynamic(() => import('@/app/(main)/mcp/mcp-client').then((m) => m.McpClient), { ssr: false });

export type CapabilityTabId = 'skills' | 'mcp';

export const CAPABILITY_TABS: readonly { id: CapabilityTabId; labelKey: string }[] = [
  { id: 'skills', labelKey: 'nav.skills' },
  { id: 'mcp', labelKey: 'nav.connectors' },
];

/** Routes whose view lives in a tab, so the nav entry stays lit on them. */
export const CAPABILITY_ROUTES = ['/skills', '/mcp'] as const;

export function CapabilitiesPage({ tabs }: { tabs: readonly CapabilityTabId[] }): ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requested = searchParams.get('tab');
  const active = tabs.find((id) => id === requested) ?? tabs[0];

  const select = useCallback((id: string) => {
    router.replace(`/capabilities?tab=${id}`, { scroll: false });
  }, [router]);

  if (!active) return <div className="p-7 text-sm text-muted-foreground">{t('common.loading')}</div>;

  // The tabs sit at the head of the view's own toolbar (search, count, create)
  // so everything shares one row on a desktop screen.
  const switcher = (
    <TabsList aria-label={t('nav.capabilities')}>
      {CAPABILITY_TABS.filter((tab) => tabs.includes(tab.id)).map((tab) => (
        <TabsTrigger key={tab.id} value={tab.id}>{t(tab.labelKey)}</TabsTrigger>
      ))}
    </TabsList>
  );

  return (
    <Tabs value={active} onValueChange={select} className="relative z-[1] h-full min-h-0">
      <TabsContent value={active} className="mt-0 h-full overflow-auto px-6 pb-8 pt-4">
        {active === 'skills' ? <SkillsClient leading={switcher} /> : <McpClient leading={switcher} />}
      </TabsContent>
    </Tabs>
  );
}
