import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Only the parameters the daemon reads are relayed; it validates them. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const qs = new URLSearchParams();
  for (const key of ['slug', 'limit', 'skip', 'repo']) {
    const value = url.searchParams.get(key);
    if (value) qs.set(key, value);
  }
  return proxyJson('GET', `/api/git/log?${qs}`);
}
