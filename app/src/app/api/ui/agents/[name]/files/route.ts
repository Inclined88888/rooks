import { proxyJson, relay, sessionProxyHeaders } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { name: string } }): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get('path') ?? '';
  const target = `/api/agents/${encodeURIComponent(params.name)}/files`
    + (path ? `?path=${encodeURIComponent(path)}` : '');
  return proxyJson('GET', target);
}

export async function DELETE(_req: Request, { params }: { params: { name: string } }): Promise<Response> {
  const url = new URL(_req.url);
  const path = url.searchParams.get('path') ?? '';
  if (!path) return new Response(JSON.stringify({ error: 'path required' }), { status: 400, headers: { 'content-type': 'application/json' } });
  return proxyJson('DELETE', `/api/agents/${encodeURIComponent(params.name)}/files?path=${encodeURIComponent(path)}`);
}

export async function POST(_req: Request, { params }: { params: { name: string } }): Promise<Response> {
  const url = new URL(_req.url);
  const path = url.searchParams.get('path') ?? '';
  const action = url.searchParams.get('action') ?? 'file';
  if (!path) return new Response(JSON.stringify({ error: 'path required' }), { status: 400, headers: { 'content-type': 'application/json' } });
  // `to` is the destination folder of a move; the daemon confines both paths.
  const to = action === 'move' ? `&to=${encodeURIComponent(url.searchParams.get('to') ?? '')}` : '';
  // `name` is the new bare name of a rename.
  const name = action === 'rename' ? `&name=${encodeURIComponent(url.searchParams.get('name') ?? '')}` : '';
  return proxyJson('POST', `/api/agents/${encodeURIComponent(params.name)}/files?path=${encodeURIComponent(path)}&action=${encodeURIComponent(action)}${to}${name}`);
}

/** Write with text/plain body. proxyJson() always serialises as JSON, so
 *  we do the raw fetch inline here. Keeps the file body bytes intact. */
export async function PUT(req: Request, { params }: { params: { name: string } }): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get('path') ?? '';
  if (!path) {
    return new Response(JSON.stringify({ error: 'path required' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }
  const body = await req.text();
  const target = `/api/agents/${encodeURIComponent(params.name)}/files?path=${encodeURIComponent(path)}`;
  const upstream = await relay(target, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain; charset=utf-8', ...sessionProxyHeaders() },
    body,
    cache: 'no-store',
  });
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}
