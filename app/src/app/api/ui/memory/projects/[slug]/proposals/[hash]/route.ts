import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: { slug: string; hash: string } }): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson(
    'POST',
    `/api/memory/projects/${encodeURIComponent(params.slug)}/proposals/${encodeURIComponent(params.hash)}`,
    body,
  );
}
