import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Proxy 1:1 towards the daemon's `/api/prefs`: chrome preferences
 *  (`scheme`, `theme`, `layout`). */
export async function PUT(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('PUT', '/api/prefs', body);
}
