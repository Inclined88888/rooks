/**
 * The anonymous usage statistics preference, as `GET /api/ui/telemetry/preference`
 * returns it. Pure helpers, so the pane and its tests share them.
 */
export const TELEMETRY_MODULE = '@timon/telemetry';
export const TELEMETRY_PREFERENCE_URL = '/api/ui/telemetry/preference';

export type TelemetrySource = 'env' | 'config' | 'settings' | 'default';

export type TelemetryPreferenceView = {
  enabled: boolean;
  source: TelemetrySource;
  malformed: boolean;
  /** False when the environment or `timon.config.json` decides. */
  editable: boolean;
  /** False on a build that sends nothing at all (source checkout, tests). */
  active: boolean;
};

const SOURCES: readonly TelemetrySource[] = ['env', 'config', 'settings', 'default'];

/** The daemon's answer, or `null` when it is not one. */
export function parseTelemetryPreference(raw: unknown): TelemetryPreferenceView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== 'boolean' || typeof r.editable !== 'boolean') return null;
  if (typeof r.source !== 'string' || !(SOURCES as readonly string[]).includes(r.source)) return null;
  return {
    enabled: r.enabled,
    source: r.source as TelemetrySource,
    malformed: r.malformed === true,
    editable: r.editable,
    active: r.active !== false,
  };
}

/** i18n key of the line explaining who decides, or `null` when the switch does. */
export function telemetryLockKey(pref: TelemetryPreferenceView): string | null {
  if (pref.source === 'env') return pref.malformed ? 'telemetrySettings.lockedEnvMalformed' : 'telemetrySettings.lockedEnv';
  if (pref.source === 'config') return pref.malformed ? 'telemetrySettings.lockedConfigMalformed' : 'telemetrySettings.lockedConfig';
  return null;
}
