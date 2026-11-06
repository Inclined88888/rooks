import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('PATCH', `/api/memory/rules/${encodeURIComponent(params.id)}`, body);
}
