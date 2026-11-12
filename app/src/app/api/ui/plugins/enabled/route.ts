/**
 * `POST /api/ui/plugins/enabled` — the gallery's toggle, with the plugin id in
 * the BODY.
 *
 * Every bundled module is `@rooks/<name>`, so the natural URL puts an encoded
 * slash in a path segment (`/api/ui/plugins/%40nova%2Fkanban/enabled`). The
 * ingress in front of the app refuses `%2F` outright: HTTP 400, empty body,
 * before Next and before any auth. That is why the switches of the product's
 * own modules did nothing — the request never reached the daemon, while an
 * unscoped id (`kanban`) travelled fine and answered 401. The id therefore
 * moves out of the path here.
 *
 * The second hop is the Next server talking to the daemon directly, inside the
 * machine, so the encoded slash it rebuilds crosses no ingress. Auth is
 * unchanged: `proxyJson` forwards the `rooks_session` cookie and nothing else,
 * and the daemon keeps deciding (403 on a `core` module, 404 on an unknown id,
 * 401 without a session).
 */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const { id, enabled } = (body ?? {}) as { id?: unknown; enabled?: unknown };
  if (typeof id !== 'string' || id.trim() === '') {
    return Response.json({ error: '`id` must be a non-empty string' }, { status: 400 });
  }
  if (typeof enabled !== 'boolean') {
    return Response.json({ error: '`enabled` must be a boolean' }, { status: 400 });
  }
  return proxyJson('POST', `/api/plugins/${encodeURIComponent(id.trim())}/enabled`, { enabled });
}
