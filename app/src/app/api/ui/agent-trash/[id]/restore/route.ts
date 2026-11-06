import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: { id: string } }): Promise<Response> {
  return proxyJson('POST', `/api/agent-trash/${encodeURIComponent(params.id)}/restore`, {});
}
