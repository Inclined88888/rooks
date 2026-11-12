import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The account's paired devices; the daemon decides whose (superadmin: all). */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/devices');
}
