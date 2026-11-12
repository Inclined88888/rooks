import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Teams of bots — the daemon scopes the list to the viewer, so the browser
// asks for everything and shows what it gets back.
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/teams');
}

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', '/api/teams', body);
}
