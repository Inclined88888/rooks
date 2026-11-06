import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Designates the main orchestrator; the daemon validates the body. */
export async function PUT(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('PUT', '/api/agents/main', body);
}
