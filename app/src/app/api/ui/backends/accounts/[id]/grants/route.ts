import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Who else may use the account. The daemon checks the session and refuses
 *  anyone but the superadmin; this proxy forwards the cookie and nothing else. */
export async function PUT(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  return proxyJson('PUT', `/api/backends/accounts/${encodeURIComponent(params.id)}/grants`, await req.json().catch(() => ({})));
}
