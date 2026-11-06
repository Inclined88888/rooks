import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The daemon validates these (zod); the proxy only relays the ones it knows.
const RELAYED = ['limit', 'kind', 'before', 'from', 'ids'] as const;

export async function GET(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const incoming = new URL(req.url).searchParams;
  const outgoing = new URLSearchParams();
  for (const name of RELAYED) {
    const value = incoming.get(name);
    if (value !== null) outgoing.set(name, value);
  }
  const qs = outgoing.size > 0 ? `?${outgoing.toString()}` : '';
  return proxyJson('GET', `/api/missions/${encodeURIComponent(params.id)}/spans${qs}`);
}
