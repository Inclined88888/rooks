import { catalogTargetQuery } from '@/lib/catalog-target';
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const query = catalogTargetQuery({ project: params.get('project'), agent: params.get('agent') });
  return proxyJson('GET', `/api/backends/catalog${query ? `?${query}` : ''}`);
}
