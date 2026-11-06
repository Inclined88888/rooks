import { proxyJson, relay, sessionProxyHeaders } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const refused = (error: string) => new Response(JSON.stringify({ error }), { status: 400, headers: { 'content-type': 'application/json' } });

/** A file outside the agent's folder, opened after the user confirmed a link in
 *  the chat. The daemon decides who may (`files:external`); this only forwards
 *  the session. */
export async function GET(req: Request, { params }: { params: { name: string } }): Promise<Response> {
  const path = new URL(req.url).searchParams.get('path') ?? '';
  if (!path) return refused('path required');
  return proxyJson('GET', `/api/agents/${encodeURIComponent(params.name)}/files/external?path=${encodeURIComponent(path)}`);
}

/** Save with a text/plain body, as the in-folder route does. */
export async function PUT(req: Request, { params }: { params: { name: string } }): Promise<Response> {
  const path = new URL(req.url).searchParams.get('path') ?? '';
  if (!path) return refused('path required');
  const upstream = await relay(
    `/api/agents/${encodeURIComponent(params.name)}/files/external?path=${encodeURIComponent(path)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'text/plain; charset=utf-8', ...sessionProxyHeaders() },
      body: await req.text(),
      cache: 'no-store',
    },
  );
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}
