import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** { enabled, command, reason? } — the UI offers the terminal action only when enabled. */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/terminal');
}
