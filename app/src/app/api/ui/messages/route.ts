import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const to = url.searchParams.get('to');
  if (!to) return new Response(JSON.stringify({ error: 'to required' }), { status: 400 });
  const qs = new URLSearchParams();
  qs.set('to', to);
  const status = url.searchParams.get('status');
  if (status) qs.set('status', status);
  const from = url.searchParams.get('from');
  if (from) qs.set('from', from);
  const limit = url.searchParams.get('limit');
  if (limit) qs.set('limit', limit);
  return proxyJson('GET', `/api/messages?${qs.toString()}`);
}
