import { isMachineId, MACHINE_HEADER } from '@/lib/machines/machine-id';
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  // A push notification's Approve/Deny names the machine that asked
  // (`public/sw.js`): the permission lives there, and the browser may have
  // been switched to another machine since. The cards of the interface send
  // nothing and answer the active machine, as before.
  const machine = req.headers.get(MACHINE_HEADER);
  if (machine !== null && !isMachineId(machine)) return Response.json({ error: 'invalid_machine' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', `/api/permissions/${encodeURIComponent(params.id)}/resolve`, body, machine === null ? {} : { machine });
}
