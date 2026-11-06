import { fetchCapabilities, isPageSurfaceAllowed } from './capabilities';
import { firstRunTarget, SETUP_PATH } from './first-run-gate';

/** Read with the new session, never with the capabilities cached on /login. */
export async function authLanding(): Promise<string> {
  const caps = await fetchCapabilities(true);
  return firstRunTarget({
    pathname: '/',
    firstRun: caps?.firstRun,
    canConfigure: caps === null ? undefined : isPageSurfaceAllowed(caps, SETUP_PATH),
  }) ?? '/';
}
