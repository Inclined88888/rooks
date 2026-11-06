import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const qs = new URL(req.url).search;
  return proxyJson('GET', `/api/vault/note${qs}`);
}
