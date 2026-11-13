import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const params = new URLSearchParams();
  if (url.searchParams.get('archived') === 'true') params.set('archived', 'true');
  if (url.searchParams.get('limit')) params.set('limit', url.searchParams.get('limit')!);
  const qs = params.toString();
  return proxyJson('GET', `/api/notifications${qs ? '?' + qs : ''}`);
}

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', '/api/notifications', body);
}
