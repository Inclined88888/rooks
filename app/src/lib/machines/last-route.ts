/**
 * The last page seen on each machine (multi-window work, V2).
 *
 * A switch is a full document load (`fleet.ts`). It used to land on `/`
 * whatever the user was reading; it now lands on the last page this browser
 * showed for the machine being entered — never the page of the machine being
 * left, whose ids mean nothing there. A machine never visited lands on `/`.
 *
 * Storage: one key per machine, through `machine-storage.ts` (`m:<id>:` prefix
 * for a remote, the bare key for local), so taking a machine out of the fleet
 * forgets its page with the rest of its state. Written on every in-app
 * navigation (`LastRouteRecorder`) and once more right before a switch.
 *
 * Only a same-origin relative path is kept, on write AND on read: the stored
 * value is browser state anyone with devtools can edit, and it ends up in
 * `location.assign`. Pages that are not a place to come back to (sign-in,
 * setup, invitations, the API) are not kept; nor is the Settings dialog
 * (`?settings=`), an overlay over the page rather than a page.
 *
 * A remembered page may name an object that no longer exists there (a
 * mission, an agent, a task deleted since). `landingRoute` asks the machine
 * being entered, through the relay, about the ids the page names
 * (`ROUTE_ID_RULES`): a 404 sends the user to the root of that page's section
 * instead of an error. Anything else — the object is there, the call failed,
 * it was too slow — keeps the page, which has its own empty states.
 */
import { activeMachineId, machineLocalStorage } from './machine-storage';

const STORAGE_KEY = 'timon:last-route';
const ROUTE_MAX = 2048;
/** A switch waits for this at most before landing on the remembered page. */
const PROBE_TIMEOUT_MS = 2_500;
/** The base a route is parsed against: any origin would do, it only has to
 *  be one the route cannot change. */
const PARSE_BASE = 'http://timon.invalid';

/** Paths that are not a place to land on after a switch. */
const NOT_A_PLACE = ['/api', '/_next', '/login', '/onboarding', '/setup', '/invite', '/confirm-email'];
/** Query parameters that open an overlay rather than name a page. */
const OVERLAY_PARAMS = ['settings'];

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * `raw` as a route worth remembering — `pathname + search`, overlay
 * parameters and fragment dropped — or `null`. Only a relative path that
 * starts with ONE `/` passes: `//host`, `/\host` (a backslash is a slash to the
 * URL parser), an absolute URL, or a path carrying whitespace or control
 * characters (which the parser strips, turning `/\t/host` into `//host`) are
 * refused outright, not repaired.
 */
export function safeRoute(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > ROUTE_MAX) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, PARSE_BASE);
  } catch {
    return null;
  }
  if (url.origin !== PARSE_BASE) return null;
  if (NOT_A_PLACE.some((prefix) => underPrefix(url.pathname, prefix))) return null;
  for (const name of OVERLAY_PARAMS) url.searchParams.delete(name);
  return `${url.pathname}${url.search}`;
}

/** Keeps `route` as the last page of `machineId` (the active machine by
 *  default). A route `safeRoute` refuses leaves the previous one in place. */
export function rememberRoute(route: string, machineId: string = activeMachineId()): void {
  const safe = safeRoute(route);
  if (safe === null) return;
  try {
    machineLocalStorage(machineId)?.setItem(STORAGE_KEY, safe);
  } catch {
    // Quota or blocked storage: the switch will land on `/`.
  }
}

/**
 * The page to open for `machineId`: its last remembered page, `/` when there
 * is none (or what is stored is not a safe route). Synchronous and network
 * free: the desktop's live views (V4) fall back on it once a machine's view
 * has been dropped.
 */
export function lastRouteFor(machineId: string): string {
  let stored: string | null = null;
  try {
    stored = machineLocalStorage(machineId)?.getItem(STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  return safeRoute(stored) ?? '/';
}

/** An id a page names, the call that tells whether it exists on the machine,
 *  and where to go when it does not. */
export interface RouteIdRule {
  /** The page, exactly (`/chat`) or by pattern (`/trace/<id>`). */
  readonly pathname: string | RegExp;
  /** The id the URL names, or `null` when it names none. */
  readonly id: (url: URL) => string | null;
  /** The relayed `GET` that answers 404 when the id is unknown there. */
  readonly probe: (id: string) => string;
  /** The root of the page's section. */
  readonly fallback: string;
}

const param = (name: string) => (url: URL): string | null => url.searchParams.get(name) || null;
const missionProbe = (id: string): string => `/api/ui/missions/${encodeURIComponent(id)}?view=status`;
const agentProbe = (name: string): string => `/api/ui/agents/${encodeURIComponent(name)}`;

/**
 * The pages that name an object of one machine in their URL. To cover another
 * one: add its rule here, with a probe that is a light `GET` answering 404 for
 * an unknown id (any other status keeps the page).
 */
export const ROUTE_ID_RULES: readonly RouteIdRule[] = [
  { pathname: '/chat', id: param('mission'), probe: missionProbe, fallback: '/chat' },
  { pathname: '/chat', id: param('agent'), probe: agentProbe, fallback: '/chat' },
  { pathname: '/chat', id: param('task'), probe: (id) => `/api/ui/tasks/${encodeURIComponent(id)}`, fallback: '/chat' },
  { pathname: '/missions', id: param('selected'), probe: missionProbe, fallback: '/missions' },
  { pathname: '/edit', id: param('agent'), probe: agentProbe, fallback: '/agents' },
];

function matches(rule: RouteIdRule, pathname: string): boolean {
  return typeof rule.pathname === 'string' ? rule.pathname === pathname : rule.pathname.test(pathname);
}

type Probe = (path: string, init: RequestInit) => Promise<Pick<Response, 'status'>>;

/** True only when the machine answers that `path` names nothing (404). */
async function absent(path: string, fetcher: Probe, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetcher(path, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    return response.status === 404;
  } catch {
    return false;
  }
}

/**
 * Where to land for `route` on the machine the relay now targets: `route`
 * itself, or the root of its section when one of the ids it names is unknown
 * there. Probes run in parallel and are bounded by `timeoutMs`.
 */
export async function landingRoute(
  route: string,
  fetcher: Probe = fetch,
  rules: readonly RouteIdRule[] = ROUTE_ID_RULES,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<string> {
  const safe = safeRoute(route);
  if (safe === null) return '/';
  const url = new URL(safe, PARSE_BASE);
  const checks = rules
    .filter((rule) => matches(rule, url.pathname))
    .flatMap((rule) => {
      const id = rule.id(url);
      return id === null ? [] : [absent(rule.probe(id), fetcher, timeoutMs).then((gone) => (gone ? rule.fallback : null))];
    });
  const fallbacks = await Promise.all(checks);
  return fallbacks.find((fallback): fallback is string => fallback !== null) ?? safe;
}
