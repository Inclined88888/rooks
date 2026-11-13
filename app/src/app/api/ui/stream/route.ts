import { proxySse, sseClientQuery } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return proxySse(`/api/stream${sseClientQuery(request)}`, request);
}
