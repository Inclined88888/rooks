import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: { id: string } };

export async function DELETE(_req: Request, { params }: Params): Promise<Response> {
  return proxyJson('DELETE', `/api/integrations/receipts/${encodeURIComponent(params.id)}`);
}
