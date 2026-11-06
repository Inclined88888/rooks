import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> { return proxyJson('GET', '/api/license'); }
export async function PUT(request: Request): Promise<Response> {
  return proxyJson('PUT', '/api/license', await request.json());
}
