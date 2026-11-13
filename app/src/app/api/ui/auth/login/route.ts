import { proxyJson } from '@/lib/ui/proxy';
import { readSameOriginJson, setupNonceHeader } from '@/lib/ui/same-origin-json';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const parsed = await readSameOriginJson(req);
  if (!parsed.ok) return parsed.response;
  const nonce = parsed.body.localDesktop === true ? setupNonceHeader() : {};
  return proxyJson('POST', '/api/auth/login', parsed.body, {}, nonce);
}
