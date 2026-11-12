import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Add ONE grant (the consent of a plugin card, TODO #597). The daemon keeps
 * the decision superadmin-only; this route only forwards the session.
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', `/api/secrets/${encodeURIComponent(params.id)}/grants`, body);
}
