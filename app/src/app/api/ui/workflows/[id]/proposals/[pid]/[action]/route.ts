import { proxyJson } from '@/lib/ui/proxy';

export async function POST(_request: Request, { params }: { params: { id: string; pid: string; action: string } }) {
  return proxyJson('POST', `/api/workflows/${encodeURIComponent(params.id)}/proposals/${encodeURIComponent(params.pid)}/${encodeURIComponent(params.action)}`);
}
