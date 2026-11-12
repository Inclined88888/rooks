import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The daemon answers 400 to an unknown parameter: only its own two are relayed. */
const RELAYED = ['mission_id', 'limit'] as const;

/** { documents } — the documents of a mission, without their HTML. */
export async function GET(req: Request): Promise<Response> {
  const incoming = new URL(req.url).searchParams;
  const qs = new URLSearchParams();
  for (const key of RELAYED) {
    const value = incoming.get(key);
    if (value !== null) qs.set(key, value);
  }
  return proxyJson('GET', `/api/ui-documents?${qs.toString()}`);
}
