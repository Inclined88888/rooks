/**
 * The interface ↔ daemon contract level this app speaks (TODO #329, P3b/P3d).
 *
 * A daemon publishes its `apiLevel` in `/api/capabilities`
 * (`orchestrator/src/kernel/capabilities.ts`, `API_LEVEL`); it moves only when
 * the contract breaks. This app decides, at the switch and on every page it
 * renders for a remote machine:
 *
 *   - below `MIN_API_LEVEL`: refused — this interface would call routes the
 *     daemon does not have, or read fields whose meaning changed;
 *   - above `APP_API_LEVEL`: allowed with a warning — the daemon is newer than
 *     this interface, which should be updated;
 *   - absent (a daemon from before the contract): allowed with a warning.
 *
 * Shared by the server (switch route, layout) and the browser (banner): no
 * server import here.
 */

/** The contract level this app is written against. */
export const APP_API_LEVEL = 1;
/** The oldest daemon contract this app still drives. */
export const MIN_API_LEVEL = 1;

export type ApiLevelVerdict = 'ok' | 'unknown' | 'too_old' | 'newer';

export function apiLevelVerdict(level: number | null | undefined): ApiLevelVerdict {
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 0) return 'unknown';
  if (level < MIN_API_LEVEL) return 'too_old';
  if (level > APP_API_LEVEL) return 'newer';
  return 'ok';
}
