/**
 * Same-origin proxy to the daemon's per-user plugin connections. Pass-through:
 * the session cookie names the owner, the upstream never returns a secret.
 */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/plugin-connections');
}

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', '/api/plugin-connections', body);
}
