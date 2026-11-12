import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { slug: string } },
): Promise<Response> {
  return proxyJson('GET', `/api/projects/${encodeURIComponent(params.slug)}/meta`);
}

export async function PUT(
  req: Request,
  { params }: { params: { slug: string } },
): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('PUT', `/api/projects/${encodeURIComponent(params.slug)}/meta`, body);
}
