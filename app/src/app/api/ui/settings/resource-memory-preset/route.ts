import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const body: unknown = await req.json().catch(() => null);
  return proxyJson('POST', '/api/settings/resource-memory-preset', body);
}
