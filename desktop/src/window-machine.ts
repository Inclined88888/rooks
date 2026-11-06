/**
 * The machine a desktop window drives (multi-window V3).
 *
 * Every window of the shell loads the same local app origin; the app relays to
 * the machine a request names (`machineIdFromRequest`, app side): the
 * `X-Timon-Machine` header first, else the `timon_machine` cookie. A window
 * pinned to a machine gets that header on every request of ITS webContents,
 * written here, in the main process — the page cannot forge it for another
 * window, and a window with no machine (`null`) leaves the cookie in charge,
 * exactly like the web and the PWA.
 *
 * The header carries an id, never a URL, and only towards the window's own
 * origin: an image or a font from another site never learns which machine a
 * window drives. Naming a machine grants nothing either: the app still
 * resolves it through the local session's owner-filtered credential.
 */

/** Copy of `LOCAL_MACHINE_ID` (`app/src/lib/machines/machine-id.ts`); `window-machine.test.ts` compares both. */
export const LOCAL_MACHINE_ID = 'local';
/** Copy of `MACHINE_HEADER` (same file); `window-machine.test.ts` compares both. */
export const MACHINE_HEADER = 'x-timon-machine';
/** Same rule as `isMachineId` (same file); `window-machine.test.ts` compares both. */
const MACHINE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The page asks for its window to drive another machine. It sends an id, and
 * the page to open should the machine have no live page in the window (V4):
 * the main process shows that machine's page, kept alive or new, and hides
 * the caller, which stays as it was (`switchToMachine`, app side).
 */
export const WINDOW_MACHINE_CHANNEL = 'timon:window-machine';

export function isMachineId(value: unknown): value is string {
  return typeof value === 'string' && MACHINE_ID.test(value);
}

/** The origin a request goes to, with a WebSocket counted as its page's scheme. */
function requestOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** What the header writer knows of a window: its origin and its machine. */
export interface PinnedWindow {
  readonly origin: string;
  readonly machineId: string | null;
}

/**
 * The request headers to send: the window's machine added (any value the page
 * set itself replaced) when the request leaves a pinned window for its own
 * origin; untouched otherwise. `lookup` answers for a webContents id; a request
 * with none (service worker, the main process's own `session.fetch`) is left
 * alone.
 */
export function withMachineHeader(
  details: { url: string; webContentsId?: number; requestHeaders: Record<string, string> },
  lookup: (webContentsId: number) => PinnedWindow | null,
): Record<string, string> {
  if (details.webContentsId === undefined) return details.requestHeaders;
  const pinned = lookup(details.webContentsId);
  if (!pinned || pinned.machineId === null) return details.requestHeaders;
  if (requestOrigin(details.url) !== requestOrigin(pinned.origin)) return details.requestHeaders;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(details.requestHeaders)) {
    if (name.toLowerCase() !== MACHINE_HEADER) headers[name] = value;
  }
  headers['X-Timon-Machine'] = pinned.machineId;
  return headers;
}

const ROUTE_MAX = 2048;

/**
 * Where a new page of a machine opens (V4): the route the switching page read
 * from `lastRouteFor`, kept only when it is a path of the window's own origin;
 * the root otherwise. The app already filters what it stores; this is the
 * shell's own check, since anything can come over IPC.
 */
export function pageUrl(origin: string, request: unknown): string {
  const root = new URL('/', origin).href;
  const route = (request as { route?: unknown } | null)?.route;
  if (typeof route !== 'string' || route.length === 0 || route.length > ROUTE_MAX) return root;
  if (!route.startsWith('/') || route.startsWith('//') || route.includes('\\')) return root;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f]/.test(route)) return root;
  try {
    const url = new URL(route, origin);
    return url.origin === new URL(origin).origin ? url.href : root;
  } catch {
    return root;
  }
}

/** The fleet as `GET /api/ui/machines` lists it: only what the title needs. */
export function machineNameIn(body: unknown, id: string): string | null {
  const machines = (body as { machines?: unknown } | null)?.machines;
  if (!Array.isArray(machines)) return null;
  for (const entry of machines) {
    const machine = entry as { id?: unknown; name?: unknown } | null;
    if (machine?.id === id && typeof machine.name === 'string' && machine.name.trim()) return machine.name.trim();
  }
  return null;
}

/** "<machine> — Timon"; just the product name until the machine is known. */
export function windowTitle(product: string, machineName: string | null): string {
  return machineName ? `${machineName} — ${product}` : product;
}

/**
 * The machine a new window opens on: the one asked for, else the one used
 * last, else none (the cookie, which is this computer unless the browser
 * switched before windows had their own machine).
 */
export function machineForNewWindow(asked: string | null | undefined, lastUsed: string | null): string | null {
  if (isMachineId(asked)) return asked;
  return isMachineId(lastUsed) ? lastUsed : null;
}
