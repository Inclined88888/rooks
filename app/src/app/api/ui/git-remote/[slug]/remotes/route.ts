import { proxyJson } from '@/lib/ui/proxy';
import { repoSuffix } from '@/lib/ui/git-repo-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const path = (slug: string, req: Request) => `/api/git-remote/${encodeURIComponent(slug)}/remotes${repoSuffix(req)}`;

export async function GET(
  req: Request,
  { params }: { params: { slug: string } },
): Promise<Response> {
  return proxyJson('GET', path(params.slug, req));
}

export async function POST(
  req: Request,
  { params }: { params: { slug: string } },
): Promise<Response> {
  // Relayed as is: the daemon's schema refuses what it does not expect.
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', path(params.slug, req), body);
}
