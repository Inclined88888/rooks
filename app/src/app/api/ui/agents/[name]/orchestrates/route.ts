import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The delegation list has its own door on the daemon: the config route strips
// it, so the editor cannot write it any other way.
export async function PUT(
  req: Request,
  { params }: { params: { name: string } },
): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('PUT', `/api/agents/${encodeURIComponent(params.name)}/orchestrates`, body);
}
