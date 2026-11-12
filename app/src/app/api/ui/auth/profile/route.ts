import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('PATCH', '/api/auth/profile', body);
}
