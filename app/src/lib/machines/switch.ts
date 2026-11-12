/**
 * Switching the active machine (TODO #329, P3d): the one place the
 * `nova_machine` cookie is written.
 *
 * The cookie only names an id; what it opens is decided again on every
 * request by `resolveTarget` (the local daemon hands out the device token of
 * that person's machine, or refuses). Writing it is still checked here, so a
 * switch never lands on a page that can only fail:
 *
 *   - back to this computer (`local`): always allowed, the cookie is dropped;
 *   - a remote id: the LOCAL daemon is asked `GET /api/machines/:id/status`
 *     with the local session. That route is filtered by owner (another
 *     account's machine is a 404, as an unknown one), and it probes the
 *     machine right now: unreachable, a device revoked there, or a contract
 *     level below `MIN_API_LEVEL` refuse the switch. A level above this app's,
 *     or none at all, is allowed with a warning the interface shows.
 *
 * A cross-site POST is refused (`foreignMutation`): nobody else's page may
 * move this browser onto another machine.
 *
 * `scope: 'window'` (multi-window V3): the same checks, and no cookie. A
 * desktop window drives its machine through the `X-Rooks-Machine` header its
 * shell writes; writing the cookie would move every window still on the
 * cookie's machine, and the web or PWA tabs of this browser profile with them. The switch itself is a full
 * document load in the browser (`lib/machines/fleet.ts`), never a client-side
 * navigation: that is what empties every in-memory cache of the previous
 * machine.
 */
import { apiLevelVerdict, MIN_API_LEVEL } from './api-level';
import { isMachineId, LOCAL_MACHINE_ID } from './machine-id';
import { localTarget, MACHINE_COOKIE, relayFetch } from './target';
import { proxyAuthHeaders, SESSION_COOKIE } from '../ui/proxy-auth';
import { foreignMutation, foreignMutationRefusal } from '../ui/same-origin-mutation';

/** A year: the choice is the browser's, until it switches again. */
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
const STATUS_TIMEOUT_MS = 12_000;

export type SwitchWarning = 'api_level_unknown' | 'api_level_newer';

function json(status: number, body: unknown, cookie?: string): Response {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  if (cookie) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/** HTTPS as the browser sees it: the reverse proxy's word first. */
export function secureRequest(req: Request): boolean {
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (proto) return proto === 'https';
  try {
    return new URL(req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** `Set-Cookie` for `id`; `local` clears the cookie (the default target). */
export function machineCookie(id: string, secure: boolean): string {
  const attributes = ['Path=/', 'SameSite=Lax', 'HttpOnly', ...(secure ? ['Secure'] : [])];
  if (id === LOCAL_MACHINE_ID) return [`${MACHINE_COOKIE}=`, 'Max-Age=0', ...attributes].join('; ');
  return [`${MACHINE_COOKIE}=${encodeURIComponent(id)}`, `Max-Age=${COOKIE_MAX_AGE_S}`, ...attributes].join('; ');
}

interface StatusAnswer {
  reachable?: unknown;
  apiLevel?: unknown;
  machine?: { status?: unknown } | null;
}

export async function switchActiveMachine(req: Request): Promise<Response> {
  if (foreignMutation(req.headers)) return foreignMutationRefusal();
  const body = await req.json().catch(() => null) as { id?: unknown; scope?: unknown } | null;
  const id = typeof body?.id === 'string' ? body.id : null;
  if (id === null || !isMachineId(id)) return json(400, { error: 'invalid_request' });
  if (body?.scope !== undefined && body.scope !== 'window' && body.scope !== 'browser') return json(400, { error: 'invalid_request' });
  const secure = secureRequest(req);
  const cookie = (machine: string): string | undefined => (body?.scope === 'window' ? undefined : machineCookie(machine, secure));
  if (id === LOCAL_MACHINE_ID) return json(200, { id, warning: null }, cookie(id));

  const session = cookieValue(req.headers.get('cookie'), SESSION_COOKIE);
  if (!session) return json(401, { error: 'machine_session_required' });
  let answer: globalThis.Response;
  try {
    answer = await relayFetch(localTarget(), `/api/machines/${encodeURIComponent(id)}/status`, {
      headers: { ...proxyAuthHeaders({ sessionToken: session }), accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
  } catch {
    return json(502, { error: 'machine_credential_unavailable' });
  }
  if (answer.status === 401) return json(401, { error: 'machine_session_required' });
  if (answer.status === 404) return json(404, { error: 'machine_unknown' });
  if (answer.status === 503) return json(503, { error: 'vault_unavailable' });
  if (!answer.ok) return json(502, { error: 'machine_credential_unavailable' });
  const status = await answer.json().catch(() => null) as StatusAnswer | null;
  if (status?.reachable !== true) {
    const why = typeof status?.machine?.status === 'string' ? status.machine.status : 'unreachable';
    return json(502, { error: 'machine_unreachable', status: why });
  }
  const apiLevel = typeof status.apiLevel === 'number' ? status.apiLevel : null;
  const verdict = apiLevelVerdict(apiLevel);
  if (verdict === 'too_old') {
    return json(409, { error: 'machine_incompatible', api_level: apiLevel, min_api_level: MIN_API_LEVEL });
  }
  const warning: SwitchWarning | null = verdict === 'unknown' ? 'api_level_unknown' : verdict === 'newer' ? 'api_level_newer' : null;
  return json(200, { id, warning }, cookie(id));
}
