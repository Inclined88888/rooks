import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** VAPID public key + activation state, for the browser-side opt-in. */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/push/config');
}
