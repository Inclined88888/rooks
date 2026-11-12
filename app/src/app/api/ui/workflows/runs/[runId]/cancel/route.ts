import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: { runId: string } }): Promise<Response> {
  return proxyJson('POST', `/api/workflows/runs/${encodeURIComponent(params.runId)}/cancel`);
}
