import { isMachineId } from '@/lib/machines/machine-id';
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: { id: string } };

/** Probes the machine now: reachable, version, apiLevel (recorded by the daemon). */
export async function GET(_req: Request, { params }: Params): Promise<Response> {
  if (!isMachineId(params.id)) return Response.json({ error: 'machine not found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
  return proxyJson('GET', `/api/machines/${encodeURIComponent(params.id)}/status`);
}
