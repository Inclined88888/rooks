import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  // `return_path` (`/apps`) brings the consent tab back to the page that started it.
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', `/api/mcp/${encodeURIComponent(params.id)}/oauth/start`, body);
}
