import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Proxy 1:1 towards the daemon's `/api/layout`: widget placement, stored
 *  server-side so it follows the user across browsers and machines. */
export async function GET(req: Request): Promise<Response> {
  const qs = new URL(req.url).search;
  return proxyJson('GET', `/api/layout${qs}`);
}

export async function PUT(req: Request): Promise<Response> {
  const qs = new URL(req.url).search;
  const body = await req.json().catch(() => ({}));
  return proxyJson('PUT', `/api/layout${qs}`, body);
}

/** Recalling a named arrangement erases the rows the preset does not hold:
 *  without it the same click would give a different screen depending on what
 *  was on it beforehand (`docs/LAYOUT-PRESETS.md`). */
export async function DELETE(req: Request): Promise<Response> {
  const qs = new URL(req.url).search;
  return proxyJson('DELETE', `/api/layout${qs}`);
}
