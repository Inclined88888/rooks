import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Pins (or clears, with an empty `agent`) the agent that runs one kind of
 *  task for this project. */
export async function PATCH(
  req: Request,
  { params }: { params: { slug: string; role: string } },
): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson(
    'PATCH',
    `/api/projects/${encodeURIComponent(params.slug)}/roles/${encodeURIComponent(params.role)}`,
    body,
  );
}
