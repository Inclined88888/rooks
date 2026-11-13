import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Starts a shell. `cwd` is validated by the daemon (agent cwd or task worktree only). */
export async function POST(req: Request): Promise<Response> {
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson('POST', '/api/terminal/web/sessions', body ?? {});
}
