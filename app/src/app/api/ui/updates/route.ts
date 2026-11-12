/**
 * Same-origin proxy to `@rooks/updates`: whether a newer Rooks is offered. The
 * daemon refuses an anonymous caller and lets any signed-in one read; the
 * session cookie is all that is forwarded, never the daemon token.
 */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/updates');
}
