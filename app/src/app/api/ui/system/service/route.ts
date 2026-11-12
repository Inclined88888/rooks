import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Installs or repairs the daemon service. The body is fixed: the daemon
 *  decides what to do from the machine, never from the browser. */
export async function POST(): Promise<Response> {
  return proxyJson('POST', '/api/admin/service/install', {});
}
