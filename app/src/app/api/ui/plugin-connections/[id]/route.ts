import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: { id: string } };
const target = (id: string) => `/api/plugin-connections/${encodeURIComponent(id)}`;

export async function PATCH(req: Request, { params }: Params): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('PATCH', target(params.id), body);
}

export async function DELETE(_req: Request, { params }: Params): Promise<Response> {
  return proxyJson('DELETE', target(params.id));
}
