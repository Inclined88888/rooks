import { proxyJson } from '@/lib/ui/proxy';
import { foreignMutation, foreignMutationRefusal } from '@/lib/ui/same-origin-mutation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Closes a document without answering it. */
export async function POST(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  if (foreignMutation(req.headers)) return foreignMutationRefusal();
  return proxyJson('POST', `/api/ui-documents/${encodeURIComponent(params.id)}/dismiss`, {});
}
