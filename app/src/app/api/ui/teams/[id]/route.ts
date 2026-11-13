import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The daemon exposes PATCH (name and/or colour) on a team, not PUT.
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('PATCH', `/api/teams/${encodeURIComponent(params.id)}`, body);
}

// Deleting a team deletes no bot: the daemon puts its members back outside
// any team.
export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  return proxyJson('DELETE', `/api/teams/${encodeURIComponent(params.id)}`);
}
