import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The compaction under way (or just ended) for this conversation, `null`
 *  otherwise: what the chat reads after a reload to resume its progress. */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  return proxyJson('GET', `/api/missions/${encodeURIComponent(params.id)}/compact`);
}

/** Starts a compaction; the daemon answers 202 at once and picks native or
 *  summary + fork itself (docs/MISSION-COMPACT.md). */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson(
    'POST',
    `/api/missions/${encodeURIComponent(params.id)}/compact`,
    body,
  );
}
