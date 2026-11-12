import { proxyMedia } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Bytes of a file the Files widget can preview (image, video, PDF, Office).
 *  Streamed through `proxyMedia` so a video seeks and nothing is buffered; the
 *  daemon decides what may leave and under which headers. */
export async function GET(req: Request, { params }: { params: { name: string } }): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get('path') ?? '';
  if (!path) {
    return new Response(JSON.stringify({ error: 'path required' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  const download = url.searchParams.get('download') === '1' ? '&download=1' : '';
  return proxyMedia(
    `/api/agents/${encodeURIComponent(params.name)}/files/raw?path=${encodeURIComponent(path)}${download}`,
    req,
  );
}
