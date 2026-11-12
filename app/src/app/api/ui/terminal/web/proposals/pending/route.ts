import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** { total, projects: [{ project, pending }] } — the per-project badge. */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/terminal/web/proposals/pending');
}
