/**
 * Where a mission's title comes from (TODO #358), by decreasing authority.
 *
 * A module of its own, with no import, because `db.ts` needs the type and the
 * generation module needs `db.ts`: the rank lives below both.
 *
 *   manual    — the user renamed the mission. Never overwritten.
 *   preset    — the launcher named it at spawn (task title, workflow node,
 *               `title` of `mission_spawn`). Never overwritten.
 *   native    — read from the CLI's own session (a backend's reader). May
 *               replace a generated title, never a manual or preset one.
 *   generated — a one-shot at the end of the first turn. Lowest rank.
 *
 * #383 / #384 (naming of delegated missions) will add their own source here
 * rather than a column: the rank is what the conditional UPDATE reads.
 *
 * The only imports are type-only, from a contract leaf that imports nothing:
 * they leave no runtime edge for a cycle.
 */
import type { MissionTitleSource as ContractMissionTitleSource } from './plugins/contract/missions.js';
import type { Assert, Equals } from './type-equality.js';
export type { MissionTitleOrigin } from './plugins/contract/missions.js';

export const MISSION_TITLE_SOURCES = ['manual', 'preset', 'native', 'generated'] as const;
export type MissionTitleSource = (typeof MISSION_TITLE_SOURCES)[number];
/** The public contract spells this list out; compilation fails if they part. */
type _MissionTitleSourcesMatchContract = Assert<Equals<MissionTitleSource, ContractMissionTitleSource>>;

export function isMissionTitleSource(v: unknown): v is MissionTitleSource {
  return typeof v === 'string' && (MISSION_TITLE_SOURCES as readonly string[]).includes(v);
}
