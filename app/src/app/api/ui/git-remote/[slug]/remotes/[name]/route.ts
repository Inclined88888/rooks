import { proxyJson } from '@/lib/ui/proxy';
import { repoSuffix } from '@/lib/ui/git-repo-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: { slug: string; name: string } };

const path = ({ slug, name }: Params['params'], req: Request) =>
  `/api/git-remote/${encodeURIComponent(slug)}/remotes/${encodeURIComponent(name)}${repoSuffix(req)}`;

export async function PATCH(req: Request, { params }: Params): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('PATCH', path(params, req), body);
}

export async function DELETE(req: Request, { params }: Params): Promise<Response> {
  return proxyJson('DELETE', path(params, req));
}
