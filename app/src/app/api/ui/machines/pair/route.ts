import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Pairs this computer with another machine: `{ url, code, name? }`. Only those
 * fields travel; the local daemon validates them (zod, strict) and makes the
 * outgoing call itself — the browser never talks to the remote.
 */
export async function POST(req: Request): Promise<Response> {
  const raw = await req.json().catch(() => ({})) as Record<string, unknown>;
  const body: Record<string, unknown> = { url: raw.url, code: raw.code };
  if (raw.name !== undefined) body.name = raw.name;
  return proxyJson('POST', '/api/machines/pair', body);
}
