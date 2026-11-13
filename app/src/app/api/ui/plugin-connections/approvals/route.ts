import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Administrators only; the daemon answers 403 to anyone else. */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/plugin-connections/approvals');
}
