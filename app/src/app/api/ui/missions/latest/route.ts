import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The mission a chat opened without `?mission=` binds (`GET /api/missions/latest`). */
export async function GET(req: Request): Promise<Response> {
  const agent = new URL(req.url).searchParams.get('agent') ?? '';
  return proxyJson('GET', `/api/missions/latest?${new URLSearchParams({ agent })}`);
}
