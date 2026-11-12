import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  req: Request,
  { params }: { params: { slug: string } },
): Promise<Response> {
  // Only the two parameters the daemon understands go through, never the raw query.
  const incoming = new URL(req.url).searchParams;
  const query = new URLSearchParams();
  for (const key of ['agents', 'to']) {
    const value = incoming.get(key);
    if (value !== null) query.set(key, value);
  }
  const suffix = query.size ? `?${query.toString()}` : '';
  return proxyJson('DELETE', `/api/projects/${encodeURIComponent(params.slug)}${suffix}`);
}
