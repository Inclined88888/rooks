import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Which events have an imported sound of the signed-in account. */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/notifications/sounds');
}
