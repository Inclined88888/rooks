/**
 * Same-origin proxy to the `@timon/secrets-vault` routes (spec §9.1). Pass-through
 * only: the upstream never returns a value, and this layer must not invent
 * one — no enrichment, no caching.
 */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `?project=<slug>` is forwarded: the daemon answers with what that project can access. */
export async function GET(req: Request): Promise<Response> {
  const project = new URL(req.url).searchParams.get('project');
  const query = project ? `?project=${encodeURIComponent(project)}` : '';
  return proxyJson('GET', `/api/secrets${query}`);
}

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', '/api/secrets', body);
}
