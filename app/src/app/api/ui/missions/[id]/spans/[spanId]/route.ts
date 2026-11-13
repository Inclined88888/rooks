import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string; spanId: string } }): Promise<Response> {
  return proxyJson('GET', `/api/missions/${encodeURIComponent(params.id)}/spans/${encodeURIComponent(params.spanId)}`);
}
