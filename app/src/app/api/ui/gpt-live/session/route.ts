/**
 * Same-origin proxy for the GPT-Live WebRTC exchange: the browser's SDP offer
 * goes to the daemon, which holds the key and answers with OpenAI's SDP.
 */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', '/api/gpt-live/session', body);
}
