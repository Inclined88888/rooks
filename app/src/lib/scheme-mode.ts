/**
 * Appearance scheme mode for Customize: fixed light/dark, or follow the OS.
 * Account prefs still store light|dark; "system" is a local override so the
 * daemon schema stays unchanged.
 */
export type SchemeMode = 'light' | 'dark' | 'system';

export const SCHEME_MODE_KEY = 'rooks.appearance.schemeMode';

export function readSchemeMode(): SchemeMode {
  if (typeof window === 'undefined') return 'dark';
  try {
    const v = window.localStorage.getItem(SCHEME_MODE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* private mode */ }
  return 'dark';
}

export function storeSchemeMode(mode: SchemeMode): void {
  try { window.localStorage.setItem(SCHEME_MODE_KEY, mode); } catch { /* */ }
}

export function osScheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
