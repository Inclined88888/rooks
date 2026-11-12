import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The owner refuses a secret request. Browser session only, like `provide`. */
export async function POST(_req: Request, { params }: { params: { id: string } }): Promise<Response> {
  return proxyJson('POST', `/api/secrets/requests/${encodeURIComponent(params.id)}/refuse`, {});
}
