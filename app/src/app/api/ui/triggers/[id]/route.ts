import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  return proxyJson('GET', `/api/triggers/${encodeURIComponent(params.id)}`);
}

export async function PATCH(req: Request, { params }: Ctx): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('PATCH', `/api/triggers/${encodeURIComponent(params.id)}`, body);
}

export async function DELETE(_req: Request, { params }: Ctx): Promise<Response> {
  return proxyJson('DELETE', `/api/triggers/${encodeURIComponent(params.id)}`);
}
