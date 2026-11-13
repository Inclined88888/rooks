import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  req: Request,
  { params }: { params: { slug: string } },
): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('PATCH', `/api/workspaces/${encodeURIComponent(params.slug)}`, body);
}

export async function DELETE(
  _req: Request,
  { params }: { params: { slug: string } },
): Promise<Response> {
  return proxyJson('DELETE', `/api/workspaces/${encodeURIComponent(params.slug)}`);
}
