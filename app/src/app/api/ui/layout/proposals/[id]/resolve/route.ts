import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Apply or ignore a layout proposal: the owner's browser session only (the daemon checks). */
export async function POST(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', `/api/layout/proposals/${encodeURIComponent(params.id)}/resolve`, body);
}
