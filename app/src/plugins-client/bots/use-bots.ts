'use client';

/**
 * Bots and teams of the `/bots` view, in one place.
 *
 * Both lists are re-read on demand (`refresh`) because every mutation of the
 * teams menu changes one or the other: renaming a team, or moving a bot,
 * which is written on the bot's own config. They are also re-read when an
 * agent is saved elsewhere (`AGENTS_CHANGED_EVENT`): "New TIM" opens the
 * shared agent editor, which knows nothing of this view, and the new TIM
 * only showed after a reload.
 */
import { useCallback, useEffect, useState } from 'react';
import { isGlobalAgent } from '@/app/agents-grid/agents-grid-client';
import { AGENTS_CHANGED_EVENT } from '@/lib/agents-changed';
import { mainBotOf, type Bot, type Team } from './types';

/** A bot of this view: no project, and not a workspace hub. Ephemeral agents
 *  are left out — they are the throwaway product of a mission, and they would
 *  bury the handful of bots the user actually named. The main agent is kept
 *  under whatever name the daemon flags (`mainBotOf`), never by its seed name
 *  `_main`, which onboarding renames away. */
export function isOrphanBot(bot: Bot, mainName: string | null): boolean {
  if (bot.project) return false;
  if (bot.ephemeral) return false;
  return bot.name === mainName || !isGlobalAgent(bot.name);
}

export type BotsData = {
  bots: Bot[];
  teams: Team[];
  loading: boolean;
  refresh: () => Promise<void>;
};

export function useBots(): BotsData {
  const [bots, setBots] = useState<Bot[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [agentsRes, teamsRes] = await Promise.all([
      fetch('/api/ui/agents', { cache: 'no-store' }).catch(() => null),
      fetch('/api/ui/teams', { cache: 'no-store' }).catch(() => null),
    ]);
    if (agentsRes?.ok) {
      const json = (await agentsRes.json()) as { agents?: Bot[] };
      const all = json.agents ?? [];
      const mainName = mainBotOf(all);
      setBots(all.filter((b) => isOrphanBot(b, mainName)));
    }
    // Teams are optional: a daemon older than the teams routes answers 404,
    // and the rail then shows every bot under "no team" instead of nothing.
    if (teamsRes?.ok) {
      const json = (await teamsRes.json()) as { teams?: Team[] };
      setTeams(json.teams ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const onChanged = (): void => { void refresh(); };
    window.addEventListener(AGENTS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(AGENTS_CHANGED_EVENT, onChanged);
  }, [refresh]);

  return { bots, teams, loading, refresh };
}
