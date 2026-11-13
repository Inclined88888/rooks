import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A one-time pairing code for the signed-in account. The browser's body is
 * not forwarded: this screen never issues a code for another account, so the
 * superadmin-only `user_id` cannot be slipped in through it.
 */
export async function POST(): Promise<Response> {
  return proxyJson('POST', '/api/devices/pairing-codes', {});
}
