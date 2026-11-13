import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The daemon binds the flow to the session cookie this proxy forwards.
export async function GET(_req: Request, { params }: { params: { id: string } }): Promise<Response> {
  return proxyJson('GET', `/api/backends/accounts/${encodeURIComponent(params.id)}/login`);
}

export async function POST(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  return proxyJson('POST', `/api/backends/accounts/${encodeURIComponent(params.id)}/login`, await req.json().catch(() => ({})));
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }): Promise<Response> {
  return proxyJson('DELETE', `/api/backends/accounts/${encodeURIComponent(params.id)}/login`);
}
