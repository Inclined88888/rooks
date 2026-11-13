import { proxyJson } from '@/lib/ui/proxy';
import { forwardedMissionQuery } from '@/lib/ui/mission-detail-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  // The light status view (polled while a turn looks stuck) and the paging of
  // the chat view (a chat opens on its last page): nothing else.
  const query = forwardedMissionQuery(new URL(req.url).searchParams);
  return proxyJson('GET', `/api/missions/${encodeURIComponent(params.id)}${query}`);
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }): Promise<Response> {
  return proxyJson('DELETE', `/api/missions/${encodeURIComponent(params.id)}`);
}
