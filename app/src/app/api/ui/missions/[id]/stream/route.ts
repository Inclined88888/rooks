import { proxySse, sseClientQuery } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: { id: string } }): Promise<Response> {
  return proxySse(
    `/api/missions/${encodeURIComponent(params.id)}/stream${sseClientQuery(request)}`,
    request,
  );
}
