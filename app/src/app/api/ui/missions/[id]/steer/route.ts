import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Redirects the turn that is running (TODO #488): Enter in the composer while
 *  the agent works. The daemon validates the body and answers how the steer
 *  landed, or `no_turn_to_steer` / `steer_unsupported` for the composer to fall
 *  back on an ordinary message or the queue. */
export async function POST(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', `/api/missions/${encodeURIComponent(params.id)}/steer`, body);
}
