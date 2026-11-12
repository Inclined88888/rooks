import { proxyJson, relay, sessionProxyHeaders } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { name: string; file: string } }): Promise<Response> {
  const upstream = await relay(
    `/api/agents/${encodeURIComponent(params.name)}/memory/${encodeURIComponent(params.file)}`,
    { cache: 'no-store', headers: sessionProxyHeaders() },
  );
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export async function PUT(req: Request, { params }: { params: { name: string; file: string } }): Promise<Response> {
  const body = await req.text();
  const upstream = await relay(
    `/api/agents/${encodeURIComponent(params.name)}/memory/${encodeURIComponent(params.file)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'text/plain; charset=utf-8', ...sessionProxyHeaders() },
      body,
      cache: 'no-store',
    },
  );
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}

export async function DELETE(_req: Request, { params }: { params: { name: string; file: string } }): Promise<Response> {
  return proxyJson(
    'DELETE',
    `/api/agents/${encodeURIComponent(params.name)}/memory/${encodeURIComponent(params.file)}`,
  );
}
