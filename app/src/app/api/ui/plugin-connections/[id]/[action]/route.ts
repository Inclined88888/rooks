import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: { id: string; action: string } };
// Only the daemon's own actions: the proxy never forwards an arbitrary path.
const ACTIONS = new Set(['test', 'approve', 'reject']);

export async function POST(_req: Request, { params }: Params): Promise<Response> {
  if (!ACTIONS.has(params.action)) return Response.json({ error: 'not found' }, { status: 404 });
  return proxyJson('POST', `/api/plugin-connections/${encodeURIComponent(params.id)}/${params.action}`);
}
