/**
 * Appearance scheme mode for Customize: fixed light/dark, or follow the OS.
 * Account prefs still store light|dark; "system" is a local override so the
 * daemon schema stays unchanged.
 */
export type SchemeMode = 'light' | 'dark' | 'system';

export const SCHEME_MODE_KEY = 'rooks.appearance.schemeMode';

/** Modes offered in Settings / onboarding (Dark is not a manual choice). */
export const SCHEME_MODE_CHOICES = ['light', 'system'] as const satisfies readonly SchemeMode[];

export function readSchemeMode(): SchemeMode {
  if (typeof window === 'undefined') return 'light';
  try {
    const v = window.localStorage.getItem(SCHEME_MODE_KEY);
    if (v === 'light' || v === 'system') return v;
    // Legacy "dark" pick: keep painting dark until the person chooses Light or System.
    if (v === 'dark') return 'dark';
  } catch { /* private mode */ }
  return 'light';
}

export function storeSchemeMode(mode: SchemeMode): void {
  try { window.localStorage.setItem(SCHEME_MODE_KEY, mode); } catch { /* */ }
}

export function osScheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
