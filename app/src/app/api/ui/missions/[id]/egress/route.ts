import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A mission's journaled connections (TODO #590). Only `limit` and `before`
 *  are relayed: the daemon refuses any other query key, and validates these. */
export async function GET(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const incoming = new URL(req.url).searchParams;
  const query = new URLSearchParams();
  for (const key of ['limit', 'before']) {
    const value = incoming.get(key);
    if (value !== null) query.set(key, value);
  }
  const qs = query.toString();
  const suffix = qs ? `?${qs}` : '';
  return proxyJson('GET', `/api/missions/${encodeURIComponent(params.id)}/egress${suffix}`);
}
