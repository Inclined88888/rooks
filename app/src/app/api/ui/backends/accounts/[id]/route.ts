import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  return proxyJson('PATCH', `/api/backends/accounts/${encodeURIComponent(params.id)}`, await req.json().catch(() => ({})));
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }): Promise<Response> {
  return proxyJson('DELETE', `/api/backends/accounts/${encodeURIComponent(params.id)}`);
}
