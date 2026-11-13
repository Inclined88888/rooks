import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: { id: string } };

export async function POST(_req: Request, { params }: Params): Promise<Response> {
  return proxyJson('POST', `/api/integrations/connections/${encodeURIComponent(params.id)}/replay-failed`);
}
