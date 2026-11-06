import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** What a switch to `backend` would do to the context, without doing it:
 *  thread size, configured threshold, the target CLI's ceiling, and whether
 *  it fits whole. The LLM menu's confirmation uses it to offer "as is" only
 *  when that is really possible. */
export async function GET(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const backend = new URL(req.url).searchParams.get('backend') ?? '';
  return proxyJson(
    'GET',
    `/api/missions/${encodeURIComponent(params.id)}/switch-preview`
    + `?backend=${encodeURIComponent(backend)}`,
  );
}
