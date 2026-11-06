import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => ({})) as { name?: unknown };
  return proxyJson('POST', '/api/license/name', { name: body.name });
}
