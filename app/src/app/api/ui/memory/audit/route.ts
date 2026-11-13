import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Curation log. `?run=<id>` targets one pass: that is what the anchor of
 *  the "memory curated" notifications points at. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const qs = new URLSearchParams();
  const run = url.searchParams.get('run');
  if (run) qs.set('run', run);
  qs.set('limit', url.searchParams.get('limit') ?? '200');
  return proxyJson('GET', `/api/memory/audit?${qs}`);
}
