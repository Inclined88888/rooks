import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** { document } — the view without its HTML, read by the chat card before it mounts the iframe. */
export async function GET(_req: Request, { params }: { params: { id: string } }): Promise<Response> {
  return proxyJson('GET', `/api/ui-documents/${encodeURIComponent(params.id)}`);
}
