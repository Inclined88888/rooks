import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/dreams/config');
}

export async function PUT(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('PUT', '/api/dreams/config', body);
}
