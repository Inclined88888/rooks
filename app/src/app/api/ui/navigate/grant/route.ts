import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The owner starts a guided tour: this mission may move the screen, for a while. */
export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', '/api/navigate/grant', body);
}

/** The owner ends it. */
export async function DELETE(): Promise<Response> {
  return proxyJson('DELETE', '/api/navigate/grant', undefined);
}
