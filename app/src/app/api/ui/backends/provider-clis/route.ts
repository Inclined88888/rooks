import { proxyJson } from '@/lib/ui/proxy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** The provider cards (`/api/host/provider-clis`): superadmin browser session only, enforced by the daemon. */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/host/provider-clis');
}
