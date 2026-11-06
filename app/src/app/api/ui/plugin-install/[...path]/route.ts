/**
 * `/api/ui/plugin-install/*` → the daemon's `/api/plugins/-/install/*`
 * (TODO #332). An allow-list, not a generic pass-through: only the four JSON
 * steps of the gallery's install flow go through. The archive upload has its
 * own route (`upload/route.ts`), which forwards bytes.
 *
 * Auth: the `timon_session` cookie only (`proxyJson` / `sessionProxyHeaders`).
 * The daemon admits a superadmin SESSION and nothing else — the daemon token
 * never travels here, and would be refused if it did.
 */
import { proxyJson, relay, sessionProxyHeaders } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: { path: string[] } };
const DAEMON_PREFIX = '/api/plugins/-/install';
const TOKEN_RE = /^[a-f0-9]{48}$/;
const notFound = (): Response => Response.json({ error: 'not found' }, { status: 404 });

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  if (params.path.join('/') !== 'candidates') return notFound();
  return proxyJson('GET', `${DAEMON_PREFIX}/candidates`);
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const step = params.path.join('/');
  if (step !== 'stage' && step !== 'confirm') return notFound();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid-body' }, { status: 400 });
  }
  return proxyJson('POST', `${DAEMON_PREFIX}/${step}`, body);
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  const [head, token, ...rest] = params.path;
  if (head !== 'staged' || !token || !TOKEN_RE.test(token) || rest.length > 0) return notFound();
  const upstream = await relay(`${DAEMON_PREFIX}/staged/${token}`, {
    method: 'DELETE',
    headers: sessionProxyHeaders(),
    cache: 'no-store',
  });
  // 204 carries no body: `proxyJson` would hand `Response` an empty string.
  return upstream.status === 204
    ? new Response(null, { status: 204 })
    : new Response(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json' } });
}
