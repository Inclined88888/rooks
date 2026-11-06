'use client';

/**
 * Saying out loud who a bot may talk to.
 *
 * The daemon's rule is asymmetric (`sendAgentMessage`, step teams.4): it only
 * fires when the SENDER has a team. A bot without one keeps its historical
 * reach; a bot in a team only reaches its team, its pilot and its
 * `reports_to`. Two different sentences, then — one rule worded as it is,
 * rather than a padlock icon nobody can interpret.
 */
import { Users } from 'lucide-react';
import { t } from '@/lib/i18n';
import type { Bot, Team } from './types';

/** Cross-team refusals come back as `<from> and <to> are not in the same
 *  team`. Recognised here so a rule reads like a rule instead of a raw
 *  daemon string; anything else is passed through untouched. */
export function explainDaemonError(message: string): string {
  const match = /^(.+) and (.+) are not in the same team$/.exec(message.trim());
  if (!match) return message;
  return t('bots.crossTeamRefused', { from: match[1] ?? '', to: match[2] ?? '' });
}

export function CloisonnementStrip({ bot, team }: {
  bot: Bot;
  team: Team | null;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-2 bg-muted/20 px-4 py-1.5 text-[10px] text-muted-foreground">
      <Users className="size-3 shrink-0" style={{ color: team?.color || undefined }} />
      <span className="truncate">
        {team ? t('bots.talksWithTeam', { bot: bot.name, team: team.name }) : t('bots.talksWithAll', { bot: bot.name })}
      </span>
    </div>
  );
}
