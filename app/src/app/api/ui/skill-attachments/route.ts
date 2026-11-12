import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const search = new URL(req.url).searchParams;
  const forward = new URLSearchParams();
  for (const key of ['scope', 'target', 'skill']) {
    const value = search.get(key);
    if (value) forward.set(key, value);
  }
  const qs = forward.size ? `?${forward.toString()}` : '';
  return proxyJson('GET', `/api/skill-attachments${qs}`);
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  return proxyJson('POST', '/api/skill-attachments', body);
}
