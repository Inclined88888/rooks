/**
 * Why the daemon is not running a bundled module, read off the `reason` it
 * sends (`/api/plugins`, `/api/capabilities`). The daemon only sends a
 * sentence, so the screens that must act on the cause — the gallery card,
 * Settings → Devices — share this one reading of it.
 *
 * The sentences are those of `planEntries` (`orchestrator/src/kernel/registry.ts`):
 * a change there must be mirrored here, `module-off-reason.test.ts` pins them.
 */

export type ModuleOffCause =
  /** The licence does not include it: no switch can change that. */
  | 'licence'
  /** Off by default, or turned off in the config: the user can turn it on. */
  | 'off'
  /** Anything else (a module it depends on, a host capability): shown as the daemon says it. */
  | 'other';

/** The daemon's current sentences. */
export const DAEMON_LICENCE_REASONS = ['not included in this licence'] as const;
export const DAEMON_OFF_REASONS = ['off by default', 'disabled in timon.config.json'] as const;

/** The French sentences of a daemon from before TODO #628: an app can briefly face one during an update. */
// french-ok: the exact sentences an older French daemon sends
const LEGACY_LICENCE_REASONS = ['non couvert par la licence'];
const LEGACY_OFF_REASONS = ['désactivé dans timon.config.json'];

const LICENCE_REASONS: ReadonlySet<string> = new Set([...DAEMON_LICENCE_REASONS, ...LEGACY_LICENCE_REASONS]);
const OFF_REASONS: ReadonlySet<string> = new Set([...DAEMON_OFF_REASONS, ...LEGACY_OFF_REASONS]);

export function moduleOffCause(reason: string | null | undefined): ModuleOffCause {
  const text = reason?.trim() ?? '';
  if (LICENCE_REASONS.has(text)) return 'licence';
  if (text === '' || OFF_REASONS.has(text)) return 'off';
  return 'other';
}
