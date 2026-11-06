import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { name: string } }): Promise<Response> {
  return proxyJson('GET', `/api/agents/${encodeURIComponent(params.name)}/skills`);
}
