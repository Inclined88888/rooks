'use client';

import { mainAgentOf } from '@/lib/main-agent';

/** Shapes shared by the rail, the teams menu and the page. */

/** The reduced projection of GET /api/agents — the one a viewer without
 *  `agents:read` also gets, `team` included (step teams.2). */
export type Bot = {
  name: string;
  project?: string | null;
  team?: string | null;
  role?: string | null;
  emoji?: string | null;
  color?: string | null;
  icon_url?: string | null;
  ephemeral?: boolean;
  /** Set by the daemon on the main agent (GET /api/agents). */
  main?: boolean;
};

/** `TeamRow` as GET /api/teams renders it. */
export type Team = {
  id: string;
  name: string;
  color: string | null;
  created_at: number;
};

/** The main agent is kept pinned at the top of the rail: it has no project
 *  either, but it is the pilot, not one bot among others. The daemon names it
 *  (`main`), whatever it was called at onboarding. */
export function mainBotOf(bots: readonly Bot[]): string | null {
  return mainAgentOf(bots);
}

/** Section holding the bots no team claims — always last in the rail. */
export const NO_TEAM = '__none__';
