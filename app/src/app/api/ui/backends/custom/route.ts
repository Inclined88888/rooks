/**
 * Same-origin proxy to the user-added backends routes. Pass-through only: the
 * upstream is write-only for the key, and this layer must not invent a way
 * back — no enrichment, no caching, no logging of the body.
 */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/backends/custom');
}

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', '/api/backends/custom', body);
}
