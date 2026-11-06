import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/settings');
}

export async function PUT(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  if (typeof body?.key !== 'string') {
    return Response.json({ error: 'key required' }, { status: 400 });
  }
  // `value: null` = back to the default. Forwarded as is: the orchestrator decides.
  return proxyJson('PUT', `/api/settings/${encodeURIComponent(body.key)}`, { value: body.value ?? null });
}
