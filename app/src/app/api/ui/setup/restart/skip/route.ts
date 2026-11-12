import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Only a machine with no supervisor may go through without a restart — the
 *  daemon refuses otherwise (409). */
export async function POST(): Promise<Response> {
  return proxyJson('POST', '/api/setup/restart/skip');
}
