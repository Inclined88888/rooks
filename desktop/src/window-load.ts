/**
 * When the first `loadURL` deserves another try (step 5.8).
 *
 * The web app is a CHILD of the daemon: the daemon answers `/api/health`
 * seconds before Next has bound its port. The shell, which only waits for the
 * daemon, therefore opens the window on an address that is legitimately still
 * refusing connections — and Chromium's failure page leaves the window showing
 * its own background colour, with no text and no way back. That is what the
 * first packaged launch looked like: a black rectangle under a "Portable mode"
 * banner, while both processes were in fact healthy (04/09/2026).
 *
 * Retrying is the whole fix, but only for the failures that a retry can cure.
 */
import { startupText } from './startup-text.js';

/** Chromium network errors that mean "nobody is listening YET". */
const TRANSIENT_ERRORS = new Set([
  -102, // ERR_CONNECTION_REFUSED — the port is not bound yet
  -104, // ERR_CONNECTION_FAILED
  -106, // ERR_INTERNET_DISCONNECTED
  -109, // ERR_ADDRESS_UNREACHABLE
  -7, //   ERR_TIMED_OUT
  -21, //  ERR_NETWORK_CHANGED
]);

export const RELOAD_DELAY_MS = 1_000;

/**
 * How long we keep retrying. Generous on purpose: a first launch migrates the
 * database, and a cold Next start on a slow machine is counted in tens of
 * seconds. Past this, retrying hides a real problem instead of absorbing a
 * slow start — the caller says so in the window.
 */
export const RELOAD_BUDGET_MS = 120_000;

export type LoadFailure = {
  errorCode: number;
  isMainFrame: boolean;
  /** Milliseconds since the window was created. */
  elapsedMs: number;
};

/**
 * `ERR_ABORTED` (-3) is excluded deliberately: it is what a navigation the user
 * or the app itself replaced looks like. Retrying it would fight the app for
 * control of its own location bar.
 */
export function shouldRetryLoad(f: LoadFailure): boolean {
  if (!f.isMainFrame) return false;
  if (f.elapsedMs >= RELOAD_BUDGET_MS) return false;
  return isTransientLoadError(f.errorCode);
}

/** "Nobody is listening yet" — as opposed to "this address is wrong". */
export function isTransientLoadError(errorCode: number): boolean {
  return TRANSIENT_ERRORS.has(errorCode);
}

/** The budget is spent on a failure a retry could have cured: say it out loud. */
export function shouldReportGiveUp(f: LoadFailure): boolean {
  return f.isMainFrame && f.elapsedMs >= RELOAD_BUDGET_MS && isTransientLoadError(f.errorCode);
}

/** Shown once the budget is spent — the window must never stay silently black. */
export function giveUpMessage(url: string, locale: string): string {
  return startupText(locale)('startup.giveUp', { url, seconds: RELOAD_BUDGET_MS / 1000 });
}
