import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Renames a mission for display. Body: { title: string | null } — blank or null clears the name. */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', `/api/missions/${encodeURIComponent(params.id)}/title`, body);
}
