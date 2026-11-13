import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The repositories of a project the Git widget can switch between. */
export async function GET(req: Request): Promise<Response> {
  const slug = new URL(req.url).searchParams.get('slug') ?? '';
  const qs = new URLSearchParams();
  if (slug) qs.set('slug', slug);
  return proxyJson('GET', `/api/git/repos?${qs}`);
}
