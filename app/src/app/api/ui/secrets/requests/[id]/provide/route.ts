import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The value an agent asked for (`secret_request`), from the owner's browser to
 * the vault. Browser session only: the proxy forwards the cookie, never the
 * daemon token. The body is relayed as is and never logged; nothing of it is
 * read here.
 */
export async function POST(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', `/api/secrets/requests/${encodeURIComponent(params.id)}/provide`, body);
}
