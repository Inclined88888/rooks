import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('PUT', `/api/secrets/${encodeURIComponent(params.id)}`, body);
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  return proxyJson('DELETE', `/api/secrets/${encodeURIComponent(params.id)}`);
}
