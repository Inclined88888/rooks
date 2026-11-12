/**
 * Same-origin proxy to `@rooks/telemetry`: whether this installation shares
 * anonymous usage statistics. The daemon refuses an anonymous caller and lets
 * only a signed-in person change it; the session cookie is what is forwarded.
 */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/telemetry/preference');
}

export async function PUT(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('PUT', '/api/telemetry/preference', body);
}
