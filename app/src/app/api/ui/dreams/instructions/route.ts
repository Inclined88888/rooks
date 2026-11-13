import { proxyJson, relay, sessionProxyHeaders } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/dreams/instructions');
}

export async function PUT(req: Request): Promise<Response> {
  const body = await req.text();
  const upstream = await relay(`/api/dreams/instructions`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain; charset=utf-8', ...sessionProxyHeaders() },
    body,
    cache: 'no-store',
  });
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}
