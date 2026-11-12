import { proxyJson } from '@/lib/ui/proxy';
import { repoSuffix } from '@/lib/ui/git-repo-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: { slug: string } },
): Promise<Response> {
  // The body names the branch picked in the Publish tab; without it the
  // daemon pushes the current branch, so an empty request stays valid.
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', `/api/git-remote/${encodeURIComponent(params.slug)}/push${repoSuffix(req)}`, body);
}
