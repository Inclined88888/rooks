import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  // `source` and `format` name one entry of the id, masked or not: the card of
  // a shadowed skill opens that skill. The daemon validates them.
  const incoming = new URL(req.url).searchParams;
  const query = new URLSearchParams();
  for (const name of ['cwd', 'source', 'format']) {
    const value = incoming.get(name);
    if (value) query.set(name, value);
  }
  const qs = query.size ? `?${query.toString()}` : '';
  return proxyJson('GET', `/api/skills/${encodeURIComponent(params.id)}${qs}`);
}

export async function DELETE(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  // `path` (optional) targets a specific managed file (Claude/project skill);
  // otherwise the orchestrator falls back to the TIMON skill with this id.
  const path = new URL(req.url).searchParams.get('path');
  const qs = path ? `?path=${encodeURIComponent(path)}` : '';
  return proxyJson('DELETE', `/api/skills/${encodeURIComponent(params.id)}${qs}`);
}
