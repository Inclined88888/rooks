import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `?backend=<name>` is forwarded as is: it decides whose account usage is
 *  read. Absent → the orchestrator's default backend. `?refresh=1` (an
 *  explicit ↻) bypasses the probe's cache. */
export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const forwarded = new URLSearchParams();
  const backend = params.get('backend');
  if (backend) forwarded.set('backend', backend);
  if (params.get('refresh') === '1') forwarded.set('refresh', '1');
  const qs = forwarded.size ? `?${forwarded.toString()}` : '';
  return proxyJson('GET', `/api/usage${qs}`);
}
