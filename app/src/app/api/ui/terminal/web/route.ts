import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** { enabled, reason?, sessions } — the caller's built-in terminal sessions. */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/terminal/web');
}
