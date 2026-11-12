import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, { params }: { params: { id: string } }): Promise<Response> {
  return proxyJson('DELETE', `/api/terminal/web/sessions/${encodeURIComponent(params.id)}`);
}
