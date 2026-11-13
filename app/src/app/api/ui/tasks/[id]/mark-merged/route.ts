import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

// Only the sha and an optional comment cross: the daemon validates both.
export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  const body = await req.json().catch(() => ({})) as { sha?: unknown; comment?: unknown };
  return proxyJson('POST', `/api/tasks/${encodeURIComponent(params.id)}/mark-merged`, {
    sha: body.sha,
    ...(body.comment !== undefined ? { comment: body.comment } : {}),
  });
}
