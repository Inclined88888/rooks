import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { name: string } }): Promise<Response> {
  // Only `slug` is forwarded: the daemon refuses any other query field.
  const slug = new URL(req.url).searchParams.get('slug');
  const qs = slug ? `?${new URLSearchParams({ slug })}` : '';
  return proxyJson('GET', `/api/agents/${encodeURIComponent(params.name)}/git${qs}`);
}
