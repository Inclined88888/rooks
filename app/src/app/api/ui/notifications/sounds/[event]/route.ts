/**
 * The imported notification sound of one event, as raw bytes
 * (`/api/notifications/sounds/:event`). Auth: the session cookie only, never
 * the daemon token. The size bound is checked here first, so a file the
 * daemon would refuse is not shipped across.
 */
import { proxyJson, relay, sessionProxyHeaders } from '@/lib/ui/proxy';
import { htmlFailureAsJson } from '@/lib/ui/proxy-errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 1024 * 1024;
const EVENT = /^(taskStarted|taskDone|taskBlocked|approval|missionDone)$/;

type Ctx = { params: { event: string } };

const bad = (status: number, error: string): Response => Response.json({ error }, { status });

export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  if (!EVENT.test(params.event)) return bad(404, 'not_found');
  const upstream = await relay(`/api/notifications/sounds/${params.event}`, {
    headers: sessionProxyHeaders(),
    cache: 'no-store',
  });
  if (!upstream.ok) return bad(upstream.status, 'not_found');
  return new Response(await upstream.arrayBuffer(), {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
}

export async function PUT(request: Request, { params }: Ctx): Promise<Response> {
  if (!EVENT.test(params.event)) return bad(404, 'not_found');
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BYTES) return bad(413, 'too_large');
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return bad(413, 'too_large');
  const name = request.headers.get('x-sound-name');
  const upstream = await relay(`/api/notifications/sounds/${params.event}`, {
    method: 'PUT',
    headers: {
      ...sessionProxyHeaders(),
      'content-type': 'application/octet-stream',
      ...(name ? { 'x-sound-name': name } : {}),
    },
    body,
    cache: 'no-store',
  });
  const text = await upstream.text();
  const failure = htmlFailureAsJson(upstream.status, upstream.headers.get('content-type'), upstream.ok);
  return new Response(failure ? failure.body : text, {
    status: upstream.status,
    headers: {
      'content-type': failure ? 'application/json' : upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}

export async function DELETE(_req: Request, { params }: Ctx): Promise<Response> {
  if (!EVENT.test(params.event)) return bad(404, 'not_found');
  return proxyJson('DELETE', `/api/notifications/sounds/${params.event}`, undefined);
}
