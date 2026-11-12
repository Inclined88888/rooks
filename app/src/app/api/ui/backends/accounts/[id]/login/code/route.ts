import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The code travels in the body only: never in a URL, where logs would keep it.
export async function POST(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  return proxyJson('POST', `/api/backends/accounts/${encodeURIComponent(params.id)}/login/code`, await req.json().catch(() => ({})));
}
