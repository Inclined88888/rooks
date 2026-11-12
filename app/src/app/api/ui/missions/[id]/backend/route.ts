import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Switches a mission to another LLM backend without forking it: same
 *  missionId, same thread, a new session primed with the context.
 *  Body: { backend: "<id>", model?: "<slug>", message?: "<follow-up>" }. */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson(
    'POST',
    `/api/missions/${encodeURIComponent(params.id)}/backend`,
    body,
  );
}
