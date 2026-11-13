import { proxyJson } from '@/lib/ui/proxy';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  return proxyJson('GET', `/api/workflows/${encodeURIComponent(params.id)}/proposals`);
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  return proxyJson('POST', `/api/workflows/${encodeURIComponent(params.id)}/proposals`, await request.json());
}
