import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Changes the model of a running mission (hot switch + override persisted
 *  on the orchestrator side). Body: { model: "<slug>" }. */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson(
    'POST',
    `/api/missions/${encodeURIComponent(params.id)}/model`,
    body,
  );
}
