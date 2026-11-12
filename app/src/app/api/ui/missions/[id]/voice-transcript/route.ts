/**
 * Same-origin proxy for the GPT-Live journal: one spoken turn written into the
 * mission's history. The daemon never hands it to the agent.
 */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', `/api/missions/${encodeURIComponent(params.id)}/voice-transcript`, body);
}
