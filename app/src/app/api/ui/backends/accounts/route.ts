import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/backends/accounts');
}

export async function POST(req: Request): Promise<Response> {
  return proxyJson('POST', '/api/backends/accounts', await req.json().catch(() => ({})));
}
