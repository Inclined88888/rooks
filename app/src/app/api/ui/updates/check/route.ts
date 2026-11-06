/**
 * Same-origin proxy: ask the daemon to read the release list now. The daemon
 * requires `settings:write`; the body is always empty, whatever the browser sent.
 */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  return proxyJson('POST', '/api/updates/check', {});
}
