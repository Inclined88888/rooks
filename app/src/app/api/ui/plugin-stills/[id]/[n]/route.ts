import { proxyBinary } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Extra stills of an installed plugin (`rooks.screenshots`). Index and `rev`
 *  come from `/api/plugins`, never from a caller-built path. */
export async function GET(
  request: Request,
  { params }: { params: { id: string; n: string } },
): Promise<Response> {
  if (!/^\d+$/.test(params.n)) return new Response('Not found', { status: 404 });
  const rev = new URL(request.url).searchParams.get('rev');
  const query = rev ? `?rev=${encodeURIComponent(rev)}` : '';
  return proxyBinary(`/plugins/${encodeURIComponent(params.id)}/still/${params.n}${query}`, { securityHeaders: true });
}
