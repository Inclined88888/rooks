import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  // Optional cwd includes the project skills and commands.
  const cwd = new URL(req.url).searchParams.get('cwd');
  const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
  return proxyJson('GET', `/api/skills${qs}`);
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  return proxyJson('POST', '/api/skills', body);
}
