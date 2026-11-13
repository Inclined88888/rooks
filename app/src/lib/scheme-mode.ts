/** Light, or follow the operating system. Dark is not a choice of its own. */
export const SCHEME_MODE_KEY = 'rooks.appearance.schemeMode';
export type SchemeMode = 'light' | 'system';

export function readSchemeMode(): SchemeMode {
  try {
    if (localStorage.getItem(SCHEME_MODE_KEY) === 'system') return 'system';
  } catch { /* private mode */ }
  return 'light';
}

export function storeSchemeMode(mode: SchemeMode): void {
  try { localStorage.setItem(SCHEME_MODE_KEY, mode); } catch { /* private mode */ }
}

export function osScheme(): 'light' | 'dark' {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** What the window paints. A first launch, with nothing stored, is light. */
export function appliedScheme(mode: SchemeMode = readSchemeMode()): 'light' | 'dark' {
  return mode === 'system' ? osScheme() : 'light';
}
