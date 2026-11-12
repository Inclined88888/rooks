import { proxyJson } from '@/lib/ui/proxy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: Request): Promise<Response> {
  return proxyJson('POST', '/api/appearance/background-image', await req.json().catch(() => ({})));
}
