import { proxyMedia } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** An image codex generated during a turn, kept by the daemon. */
export async function GET(req: Request, { params }: { params: { id: string; file: string } }): Promise<Response> {
  const download = new URL(req.url).searchParams.get('download') === '1' ? '?download=1' : '';
  return proxyMedia(`/api/missions/${encodeURIComponent(params.id)}/media/${encodeURIComponent(params.file)}${download}`, req);
}
