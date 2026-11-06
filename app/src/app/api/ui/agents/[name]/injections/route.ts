import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { name: string } }): Promise<Response> {
  const search = new URL(req.url).searchParams;
  const forward = new URLSearchParams();
  for (const key of ['mission_text', 'mission_id']) {
    const value = search.get(key);
    if (value) forward.set(key, value);
  }
  const qs = forward.size ? `?${forward.toString()}` : '';
  return proxyJson('GET', `/api/agents/${encodeURIComponent(params.name)}/injections${qs}`);
}
