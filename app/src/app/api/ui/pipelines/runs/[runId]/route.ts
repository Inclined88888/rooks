import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { runId: string } }): Promise<Response> {
  return proxyJson('GET', `/api/pipelines/runs/${encodeURIComponent(params.runId)}`);
}
