import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string; name: string } },
): Promise<Response> {
  return proxyJson(
    'DELETE',
    `/api/teams/${encodeURIComponent(params.id)}/members/${encodeURIComponent(params.name)}`,
  );
}
