import { isMachineId } from '@/lib/machines/machine-id';
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: { id: string } };

function notFound(): Response {
  return Response.json({ error: 'machine not found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
}

/** Rename: the daemon validates `{ name }` (zod, strict). */
export async function PATCH(req: Request, { params }: Params): Promise<Response> {
  if (!isMachineId(params.id)) return notFound();
  const raw = await req.json().catch(() => ({})) as Record<string, unknown>;
  return proxyJson('PATCH', `/api/machines/${encodeURIComponent(params.id)}`, { name: raw.name });
}

/** Remove from the fleet; the daemon revokes this computer's device on the machine, best effort. */
export async function DELETE(_req: Request, { params }: Params): Promise<Response> {
  if (!isMachineId(params.id)) return notFound();
  return proxyJson('DELETE', `/api/machines/${encodeURIComponent(params.id)}`);
}
