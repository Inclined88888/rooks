/**
 * systemd unit names isolated per instance (`ROOKS_HOME`).
 *
 * A second orchestrator (test, temporary `ROOKS_HOME`, forgotten guard)
 * must never see or stop the units of another home. On 29/08/2026,
 * `stopMissionScopes()` listed `rooks-mission-*.scope` without a filter and killed
 * two production missions — including the one that had launched it.
 */
import { createHash } from 'node:crypto';
import { ROOKS_HOME } from '../paths.js';

export function resolveNovaHome(home?: string): string {
  return home ?? ROOKS_HOME;
}

/** 8 hex of the sha256 of `ROOKS_HOME` — instance identifier in the unit names. */
export function instanceId(home?: string): string {
  return createHash('sha256').update(resolveNovaHome(home)).digest('hex').slice(0, 8);
}

export function instancePrefix(home?: string): string {
  return `rooks-${instanceId(home)}`;
}

export function missionSlice(home?: string): string {
  return `${instancePrefix(home)}-missions.slice`;
}

export function missionScopePattern(home?: string): string {
  return `${instancePrefix(home)}-mission-*.scope`;
}

/** Names from before 2.2.1, still carried by production missions in flight. */
export const LEGACY_MISSION_SCOPE_PATTERN = 'rooks-mission-*.scope';

/** Helper set here for 2.2.5 (grepai) — same prefix, a single place. */
export function grepaiWatcherUnit(slug: string, home?: string): string {
  return `${instancePrefix(home)}-grepai-watch-${slug}`;
}

export function isOwnMissionScope(unit: string, home?: string): boolean {
  return unit.startsWith(`${instancePrefix(home)}-mission-`) && unit.endsWith('.scope');
}

export function isLegacyMissionScope(unit: string): boolean {
  return unit.startsWith('rooks-mission-') && unit.endsWith('.scope');
}
