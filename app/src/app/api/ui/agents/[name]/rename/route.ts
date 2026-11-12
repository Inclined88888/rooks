import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: { name: string } },
): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', `/api/agents/${encodeURIComponent(params.name)}/rename`, body);
}
