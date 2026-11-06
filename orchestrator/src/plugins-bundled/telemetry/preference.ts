/**
 * Whether this installation shares anonymous usage statistics.
 *
 * Same order as every other setting — environment, then `timon.config.json`,
 * then the settings table, then the default — but NOT through the settings
 * registry: the registry reads an unparsable value as "use the default", and
 * the default here is ON. For a privacy switch a value nobody can read must
 * mean OFF, whichever source holds it. The row is also kept out of the
 * registry so the generic `PUT /api/settings/:key` (open during first run)
 * cannot write it: only `PUT /api/telemetry/preference` does, for a person.
 */
import { config } from '../../config/load.js';
import { dbApi } from '../../db.js';

export const TELEMETRY_ENV = 'TIMON_TELEMETRY';
/** Key of the row in the `settings` table, written by the preference route. */
export const TELEMETRY_SETTING_KEY = 'TIMON_TELEMETRY';

export type PreferenceSource = 'env' | 'config' | 'settings' | 'default';

export type TelemetryPreference = {
  enabled: boolean;
  source: PreferenceSource;
  /** The source that decided held a value that is not a yes or a no. */
  malformed: boolean;
};

const YES = new Set(['1', 'true', 'on', 'yes']);
const NO = new Set(['0', 'false', 'off', 'no']);

/** `true` / `false`, or `null` when the value says neither. */
export function parseToggle(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw === 1 ? true : raw === 0 ? false : null;
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (YES.has(value)) return true;
  if (NO.has(value)) return false;
  return null;
}

export type PreferenceSources = {
  env?: NodeJS.ProcessEnv;
  /** `telemetry.enabled` of the configuration; throws when the file cannot be read. */
  configValue?: () => unknown;
  /** The settings-table row, `null` when absent. */
  stored?: () => string | null;
};

function decide(raw: unknown, source: PreferenceSource): TelemetryPreference {
  const parsed = parseToggle(raw);
  return parsed === null
    ? { enabled: false, source, malformed: true }
    : { enabled: parsed, source, malformed: false };
}

export function resolvePreference(sources: PreferenceSources = {}): TelemetryPreference {
  const env = sources.env ?? process.env;
  const fromEnv = env[TELEMETRY_ENV];
  if (fromEnv !== undefined && fromEnv !== '') return decide(fromEnv, 'env');

  let fromConfig: unknown;
  try {
    fromConfig = (sources.configValue ?? (() => config().telemetry.enabled))();
  } catch {
    // A configuration that cannot be read may well be the one that says no.
    return { enabled: false, source: 'config', malformed: true };
  }
  if (fromConfig !== undefined) return decide(fromConfig, 'config');

  let stored: string | null;
  try {
    stored = (sources.stored ?? (() => dbApi.getAllSettings()[TELEMETRY_SETTING_KEY] ?? null))();
  } catch {
    return { enabled: false, source: 'settings', malformed: true };
  }
  if (stored !== null) return decide(stored, 'settings');

  return { enabled: true, source: 'default', malformed: false };
}

/** Only the settings row is ours to write; an env or config value wins over it. */
export function preferenceEditable(pref: TelemetryPreference): boolean {
  return pref.source === 'settings' || pref.source === 'default';
}

export function writePreference(enabled: boolean): void {
  dbApi.setSetting(TELEMETRY_SETTING_KEY, enabled ? '1' : '0');
}
