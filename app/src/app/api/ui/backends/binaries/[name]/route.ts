import { proxyJson } from '@/lib/ui/proxy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function PUT(req: Request, { params }: { params: { name: string } }): Promise<Response> {
  return proxyJson('PUT', `/api/host/binaries/${encodeURIComponent(params.name)}`, await req.json().catch(() => ({})));
}
export async function DELETE(_req: Request, { params }: { params: { name: string } }): Promise<Response> {
  return proxyJson('DELETE', `/api/host/binaries/${encodeURIComponent(params.name)}`);
}
