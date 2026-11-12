import { proxyJson } from '@/lib/ui/proxy';

export async function POST(request: Request, { params }: { params: { kind: string; id: string } }) {
  const body = await request.json().catch(() => ({}));
  return proxyJson('POST', `/api/workflows/import/${encodeURIComponent(params.kind)}/${encodeURIComponent(params.id)}`, body);
}
