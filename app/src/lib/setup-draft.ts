/**
 * What the first-run screen holds that the user chose or typed: the CLI paths
 * of the recourse fields and the web-app box. Kept for the browser session so
 * that a reload — the gesture a tester tries after installing a prerequisite by
 * hand — does not empty the form (SUG-0006).
 */
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type SetupDraft = { binaries: Record<string, string>; appEnabled: boolean };

export const SETUP_DRAFT_KEY = 'rooks.setupDraft';

/** An emptied field is no choice: keeping it would hold the form open for nothing. */
function typedPaths(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
    typeof entry[1] === 'string' && entry[1].trim() !== ''));
}

export function loadSetupDraft(storage: DraftStorage | null): SetupDraft | null {
  if (!storage) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(storage.getItem(SETUP_DRAFT_KEY) ?? 'null');
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const stored = raw as { binaries?: unknown; appEnabled?: unknown };
  const draft: SetupDraft = { binaries: typedPaths(stored.binaries), appEnabled: stored.appEnabled === true };
  return Object.keys(draft.binaries).length > 0 || draft.appEnabled ? draft : null;
}

export function saveSetupDraft(storage: DraftStorage | null, draft: SetupDraft): void {
  if (!storage) return;
  const binaries = typedPaths(draft.binaries);
  try {
    if (Object.keys(binaries).length > 0 || draft.appEnabled) {
      storage.setItem(SETUP_DRAFT_KEY, JSON.stringify({ binaries, appEnabled: draft.appEnabled }));
    } else {
      storage.removeItem(SETUP_DRAFT_KEY);
    }
  } catch {
    // A full or blocked storage costs the draft, never the screen.
  }
}

/** Once the configuration is written the draft has nothing left to restore. */
export function clearSetupDraft(storage: DraftStorage | null): void {
  if (!storage) return;
  try { storage.removeItem(SETUP_DRAFT_KEY); } catch { /* same as above */ }
}

/** Below this, coming back to the window does not ask the daemon again. */
export const RETURN_REFRESH_MIN_MS = 2_000;

/**
 * Whether coming back to the window (focus, tab shown again) re-reads the
 * prerequisites: the user may have just installed one in a terminal. Never
 * while the screen is acting, never twice in a row for one return — `focus`
 * and `visibilitychange` usually fire together.
 */
export function shouldRefreshOnReturn(input: { visible: boolean; busy: boolean; lastRefreshAt: number; now: number }): boolean {
  return input.visible && !input.busy && input.now - input.lastRefreshAt >= RETURN_REFRESH_MIN_MS;
}
