'use client';

/**
 * `/bots` — the route's island: the chat of the bot picked in the rail.
 *
 * The rail is a widget (`bots-rail-widget.tsx`) shown in an island of its own,
 * beside this one: when the view holds no arrangement yet, the page lays out
 * both (`botsSeedTree`). The selected bot lives in `?agent=`, not in a state
 * of this component: a deep link opens the right conversation, the back
 * button walks back through the bots that were visited, and the rail's island
 * talks to this one through the URL alone.
 *
 * Right after the onboarding the page is also where the main TIM welcomes its
 * person (`bots-welcome.tsx`): while the daemon says the welcome has not ended
 * (`capabilities.mainAgentOnboarding`), the main TIM's chat is that
 * conversation, and it stays on screen for the rest of the visit.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Bot as BotIcon, PanelLeft, Plus } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useIslandContentTypes } from '@/components/islands/island-content';
import { useWorkspaceLayout } from '@/components/workspace-layout-provider';
import { useStoredLayout } from '@/hooks/use-stored-layout';
import { t } from '@/lib/i18n';
import { islandsScope, recallArrangement } from '@/lib/island-arrangements-io';
import { openInIsland, useIslandBus } from '@/lib/island-bus';
import { openAgentEditor } from '@/components/agent-editor/agent-editor-modal';
import { useCapabilities } from '@/lib/capabilities';
import { BOTS_ROUTE, botsRailContent, botsSeedTree, isBotsRailTab } from './bots-islands';
import { BotsRail } from './bots-rail';
import { useBotPick, useBotStates } from './bots-rail-widget';
import { BotsWelcome, botsChatMode } from './bots-welcome';
import { CloisonnementStrip } from './cloisonnement';
import { mainBotOf } from './types';
import { useBots } from './use-bots';

// Loaded on demand: the page paints before the chat is fetched.
const ChatClient = dynamic(() => import('@/app/chat/chat-client').then((m) => m.ChatClient), { ssr: false });

/**
 * Lays the two islands out once per visit when the view's row is empty: the
 * first visit, or after the user brought the view down to its page alone —
 * that gesture holds until they leave, the next visit shows the rail again.
 */
function useSeedBotsIslands(): void {
  const pathname = usePathname();
  const { key, view } = useWorkspaceLayout();
  // The provider follows the route one render late: seeding before it names
  // this view would lay the rail on the page just left.
  const here = key && view === pathname ? key : null;
  const row = useStoredLayout(here ? islandsScope(here) : null);
  const registered = useIslandContentTypes();
  const types = useMemo(() => new Map([...registered].map(([typeId, type]) => [typeId, type.options])), [registered]);
  const seeded = useRef(new Set<string>());
  useEffect(() => {
    if (!here || !row.ready || row.raw !== null) return;
    const scope = islandsScope(here);
    if (seeded.current.has(scope)) return;
    seeded.current.add(scope);
    void recallArrangement(here, { id: 'bots', name: t('nav.bots'), createdAt: 0, tree: botsSeedTree(), menu: false }, types);
  }, [here, row.ready, row.raw, types]);
}

export function BotsPage(): React.ReactElement {
  const params = useSearchParams();
  const router = useRouter();
  const selected = params.get('agent');
  const { bots, teams, loading, refresh } = useBots();
  const [drawer, setDrawer] = useState(false);
  const states = useBotStates();
  const bus = useIslandBus();
  useSeedBotsIslands();

  // The landing page after onboarding: with no bot named, the main one is
  // open, ready to talk to. `replace`: there is nothing to go back to.
  const main = mainBotOf(bots);
  useEffect(() => {
    if (!selected && !loading && main) router.replace(`${BOTS_ROUTE}?agent=${encodeURIComponent(main)}`);
  }, [selected, loading, main, router]);

  // The welcome, or the plain chat (`botsChatMode`).
  const caps = useCapabilities();
  const [welcomeMission, setWelcomeMission] = useState<{ agent: string; missionId: string } | null>(null);
  const onWelcomeMission = useCallback((agent: string, missionId: string) => setWelcomeMission({ agent, missionId }), []);
  const onWelcomeClosed = useCallback(() => setWelcomeMission(null), []);
  const chatMode = botsChatMode({ selected, main, caps, welcomeAgent: welcomeMission?.agent ?? null });

  const selectedBot = useMemo(
    () => bots.find((bot) => bot.name === selected) ?? null,
    [bots, selected],
  );

  // The rail's own island is the usual way to pick. Without it — a phone,
  // where islands become tabs, or the island closed — a drawer stands in.
  const railShown = !bus.narrow && bus.tabs.some((tab) => isBotsRailTab(tab.content));
  const closeDrawer = useCallback(() => setDrawer(false), []);
  const pick = useBotPick(closeDrawer);
  const showRail = () => {
    if (!bus.narrow && openInIsland(botsRailContent(), { edge: 'left' })) return;
    setDrawer(true);
  };

  // Fills the page's island rather than the viewport: split, the island is a
  // fraction of the screen and `--timon-topbar-h` reads 0 inside it, so a
  // viewport height pushed the chat's composer out of the island's clip.
  return (
    <main className="flex min-h-0 flex-1">
      {/* This view's audience is the non-technical user, who reads it on a
          phone as often as not. */}
      <Sheet open={drawer} onOpenChange={setDrawer}>
        <SheetContent side="left" className="w-[280px] p-0 sm:max-w-[280px]">
          <SheetTitle className="sr-only">{t('nav.bots')}</SheetTitle>
          <BotsRail bots={bots} teams={teams} selected={selected} states={states} onSelect={pick} onChanged={refresh} />
        </SheetContent>
      </Sheet>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!railShown && (
          <button
            type="button"
            onClick={showRail}
            className="flex items-center gap-1.5 px-4 py-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <PanelLeft className="size-3.5" />
            {selected ?? t('bots.showRail')}
          </button>
        )}
        {selected && selectedBot && (
          <CloisonnementStrip
            bot={selectedBot}
            team={teams.find((team) => team.id === selectedBot.team) ?? null}
          />
        )}
        {selected ? (
          /* Keyed on the bot, like `chat-route.tsx`: without a remount the
             chat keeps the previous agent's project and mission, and shows
             the wrong conversation. `forcedAgent` also keeps the chat from
             canonicalising the URL back to `/chat`. */
          <Suspense fallback={null}>
            {chatMode === 'welcome'
              ? <BotsWelcome key={`welcome:${selected}`} onMission={onWelcomeMission} onClosed={onWelcomeClosed} />
              : chatMode === 'chat' && <ChatClient key={selected} forcedAgent={selected} compact chromeComplet />}
          </Suspense>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <BotIcon className="size-8 text-muted-foreground/60" />
            <p className="max-w-sm text-[12px] text-muted-foreground">
              {bots.length > 0 ? t('bots.emptyTitle') : t('bots.emptyNoBots')}
            </p>
            <Link
              href="/edit?new=1"
              onClick={(e) => {
                e.preventDefault();
                openAgentEditor({ isNew: true });
              }}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] transition-colors hover:bg-muted/40"
            >
              <Plus className="size-3.5" />
              {t('bots.newBot')}
            </Link>
          </div>
        )}
      </section>
    </main>
  );
}
