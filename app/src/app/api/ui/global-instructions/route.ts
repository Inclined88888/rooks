import { proxyJson, relay, sessionProxyHeaders } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/global-instructions');
}

/** Write with a text/plain body. `proxyJson()` always serialises as JSON, so the
 *  raw fetch is done here: the file's bytes reach the daemon untouched. */
export async function PUT(req: Request): Promise<Response> {
  const upstream = await relay(`/api/global-instructions`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain; charset=utf-8', ...sessionProxyHeaders() },
    body: await req.text(),
    cache: 'no-store',
  });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}
