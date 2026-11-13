import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') ?? '';
  const qs = new URLSearchParams();
  if (slug) qs.set('slug', slug);
  const repo = url.searchParams.get('repo');
  if (repo) qs.set('repo', repo);
  return proxyJson('GET', `/api/git/status?${qs}`);
}
