/** First-boot eligibility survives account creation, configuration and restarts. */
import { existsSync, readdirSync } from 'node:fs';
import { db, dbApi } from './db.js';
import { AGENTS_DIR, PROJECTS_DIR } from './paths.js';
import { isFirstRun } from './setup.js';
import type { AgentConfig } from './agent-config.js';

export const TEAM_STATE_KEY = 'onboarding.team.v1';
export type TeamPreset = 'team' | 'scratch';
/**
 * What a SAVED state may hold. `company` was a third preset, removed with the
 * page it organised: it is no longer choosable, but an install that started it
 * before the removal still carries it here, and widening the read is what keeps
 * `preset_locked` honest instead of crashing on an unknown value.
 */
export type SavedTeamPreset = TeamPreset | 'company';
export type PlannedAgent = { name: string; prompt: string; config: AgentConfig };
export type TeamState = {
  status: 'pending' | 'applying' | 'complete';
  preset?: SavedTeamPreset;
  agents?: PlannedAgent[];
};

export function readTeamState(): TeamState | null {
  const raw = dbApi.getAllSettings()[TEAM_STATE_KEY];
  return raw ? JSON.parse(raw) as TeamState : null;
}

export function writeTeamState(state: TeamState): void {
  dbApi.setSetting(TEAM_STATE_KEY, JSON.stringify(state));
}

function hasEntries(path: string): boolean {
  return existsSync(path) && readdirSync(path).length > 0;
}

export function hasUserWork(): boolean {
  return ['projects', 'missions', 'tasks', 'routines', 'triggers'].some((table) =>
    Boolean(db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()),
  ) || hasEntries(PROJECTS_DIR);
}

/** Called before any stock agent is seeded. Existing installs never opt in. */
export function initializeTeamOnboarding(): void {
  if (readTeamState() || !isFirstRun() || hasEntries(AGENTS_DIR)
      || dbApi.countUsers() > 0 || hasUserWork()) return;
  writeTeamState({ status: 'pending' });
}

export function teamOnboardingPending(): boolean {
  const state = readTeamState();
  return state !== null && state.status !== 'complete';
}
