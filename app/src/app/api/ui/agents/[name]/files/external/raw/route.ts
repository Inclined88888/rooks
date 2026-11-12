import { proxyMedia } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Bytes of a previewable file outside the agent's folder (see `../route.ts`). */
export async function GET(req: Request, { params }: { params: { name: string } }): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get('path') ?? '';
  if (!path) {
    return new Response(JSON.stringify({ error: 'path required' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  const download = url.searchParams.get('download') === '1' ? '&download=1' : '';
  return proxyMedia(
    `/api/agents/${encodeURIComponent(params.name)}/files/external/raw?path=${encodeURIComponent(path)}${download}`,
    req,
  );
}
