import { proxyJson } from '@/lib/ui/proxy';
import { repoSuffix } from '@/lib/ui/git-repo-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: { slug: string } },
): Promise<Response> {
  return proxyJson('GET', `/api/git-remote/${encodeURIComponent(params.slug)}${repoSuffix(req)}`);
}
