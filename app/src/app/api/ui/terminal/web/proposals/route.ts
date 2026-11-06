import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The daemon answers 400 to an unknown parameter: only its own three are relayed. */
const RELAYED = ['mission_id', 'status', 'limit'] as const;

/** { requests } — the caller's command requests, latest first. */
export async function GET(req: Request): Promise<Response> {
  const incoming = new URL(req.url).searchParams;
  const qs = new URLSearchParams();
  for (const key of RELAYED) {
    const value = incoming.get(key);
    if (value !== null) qs.set(key, value);
  }
  const query = qs.toString();
  return proxyJson('GET', `/api/terminal/web/proposals${query ? `?${query}` : ''}`);
}
