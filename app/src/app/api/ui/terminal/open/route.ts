import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Opens the native terminal on `cwd`. Path validation is the daemon's:
 *  only an agent cwd or a task worktree is accepted. */
export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  if (typeof body?.cwd !== 'string' || !body.cwd.trim()) {
    return Response.json({ error: 'cwd is required' }, { status: 400 });
  }
  return proxyJson('POST', '/api/terminal/open', { cwd: body.cwd });
}
