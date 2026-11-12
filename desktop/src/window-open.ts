/**
 * "Open in a new window" (multi-window V5, TODO #260): a page asks for one
 * more window on the same machine, at one of its routes.
 *
 * The page sends a route and, at most, the id of the machine it shows; never
 * a URL. The main process builds the address itself from the calling window's
 * own origin, so the new window can only ever load the interface the caller
 * already shows: no other site, no other scheme, no `file:`. Nothing here
 * widens what a window may navigate to (`setWindowOpenHandler` and
 * `will-navigate` are untouched): the window is created by the main process
 * and loads the address it was given.
 */
import { isMachineId } from './window-machine.js';

export const OPEN_WINDOW_CHANNEL = 'rooks:open-window';

/** Same bound as the app's remembered routes (`last-route.ts`). */
const ROUTE_MAX = 2048;

export interface OpenWindowRequest {
  /** The address to load: `origin` + the route, nothing else. */
  readonly url: string;
  /** The machine the page said it shows, or `null` when it named none. */
  readonly machineId: string | null;
}

/**
 * The request as the main process acts on it, or `null` when it is anything
 * but `{ route, machineId? }` with a relative path that stays on `origin`.
 * Refused outright, not repaired: `//host`, `/\host` (a backslash is a slash to
 * the URL parser), an absolute URL, whitespace or control characters (which
 * the parser strips, turning `/\t/host` into `//host`), unknown keys.
 */
export function parseOpenWindowRequest(input: unknown, origin: string): OpenWindowRequest | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) if (key !== 'route' && key !== 'machineId') return null;
  const { route, machineId } = record;
  if (machineId !== undefined && machineId !== null && !isMachineId(machineId)) return null;
  if (typeof route !== 'string' || route.length === 0 || route.length > ROUTE_MAX) return null;
  if (!route.startsWith('/') || route.startsWith('//') || route.includes('\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f]/.test(route)) return null;
  let base: URL;
  let url: URL;
  try {
    base = new URL(origin);
    url = new URL(route, base.origin);
  } catch {
    return null;
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;
  if (url.origin !== base.origin) return null;
  url.hash = '';
  return { url: url.href, machineId: isMachineId(machineId) ? machineId : null };
}

/**
 * The machine the new window drives: the caller's own when it is pinned (the
 * shell's word over the page's), else the one the page shows, pinned so that
 * a later switch elsewhere does not move it, else none (the cookie, like its
 * source).
 */
export function machineForDetachedWindow(callerMachine: string | null, asked: string | null): string | null {
  return callerMachine ?? asked;
}
