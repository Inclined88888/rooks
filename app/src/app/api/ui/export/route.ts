import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The data export, reachable from the locked beta screen. The body is fixed:
 * a locked daemon refuses a caller-chosen `out`, and a browser has no reason
 * to name a path on the host.
 */
export async function POST(): Promise<Response> {
  return proxyJson('POST', '/api/admin/export', {});
}
