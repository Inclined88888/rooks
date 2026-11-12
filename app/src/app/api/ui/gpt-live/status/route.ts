/** Same-origin proxy to `@rooks/gpt-live`: enabled flag and key presence, never the key. */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/gpt-live/status');
}
