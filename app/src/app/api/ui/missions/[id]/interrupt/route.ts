import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Cuts the current turn WITHOUT ending the conversation (the composer's STOP
 *  button). Not to be confused with the mission's DELETE, which closes it for
 *  good and makes the session impossible to resume. */
export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  return proxyJson('POST', `/api/missions/${encodeURIComponent(params.id)}/interrupt`);
}
