import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 1:1 proxy: how Timon runs on the DAEMON's machine (Settings › System ›
 *  Installation). Superadmin is enforced by the daemon on the session cookie. */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/admin/system');
}
