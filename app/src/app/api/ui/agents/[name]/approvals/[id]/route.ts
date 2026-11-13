import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, { params }: { params: { name: string; id: string } }): Promise<Response> {
  return proxyJson('DELETE', `/api/agents/${encodeURIComponent(params.name)}/approvals/${encodeURIComponent(params.id)}`);
}
