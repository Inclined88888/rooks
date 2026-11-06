import { proxyJson } from '@/lib/ui/proxy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/backends/claude-token');
}
export async function PUT(req: Request): Promise<Response> {
  return proxyJson('PUT', '/api/backends/claude-token', await req.json().catch(() => ({})));
}
export async function DELETE(): Promise<Response> {
  return proxyJson('DELETE', '/api/backends/claude-token');
}
