import { proxyJson } from '@/lib/ui/proxy';
import { foreignMutation, foreignMutationRefusal } from '@/lib/ui/same-origin-mutation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** { reply } — the owner's answer to a document, sent by the card, never by the document itself. */
export async function POST(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  if (foreignMutation(req.headers)) return foreignMutationRefusal();
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', `/api/ui-documents/${encodeURIComponent(params.id)}/reply`, body);
}
