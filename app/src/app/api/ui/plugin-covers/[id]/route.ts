import { proxyBinary } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Cover art of an installed plugin. Same shape as `plugin-bundles`: the id and
 *  the `rev` come from `/api/plugins`, never from a caller-built path. */
export async function GET(request: Request, { params }: { params: { id: string } }): Promise<Response> {
  const rev = new URL(request.url).searchParams.get('rev');
  const query = rev ? `?rev=${encodeURIComponent(rev)}` : '';
  return proxyBinary(`/plugins/${encodeURIComponent(params.id)}/cover${query}`, { securityHeaders: true });
}
