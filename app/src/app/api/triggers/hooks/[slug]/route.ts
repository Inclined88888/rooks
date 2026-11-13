import { localTarget, relayFetch } from '@/lib/machines/target';
import { readBounded, relayHeaders, TRIGGER_RELAY_BODY_LIMIT, TRIGGER_SLUG_RE } from '@/lib/trigger-hook-relay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The URL copied from the Triggers page: same path on the app and the daemon.
 *  Always this app's own daemon: the sender is an outside service, never a
 *  browser with an active machine. */
export async function POST(req: Request, { params }: { params: { slug: string } }): Promise<Response> {
  // Same answer as the daemon for an unknown route: no oracle on the names.
  if (!TRIGGER_SLUG_RE.test(params.slug)) return Response.json({ error: 'authentication failed' }, { status: 401 });
  try {
    const body = await readBounded(req.body, TRIGGER_RELAY_BODY_LIMIT);
    if (!body) return Response.json({ error: 'payload too large' }, { status: 413 });
    const response = await relayFetch(localTarget(), `/api/triggers/hooks/${params.slug}`, {
      method: 'POST', headers: relayHeaders(req.headers), body, signal: AbortSignal.timeout(15_000), cache: 'no-store',
    });
    const headers = new Headers({ 'content-type': response.headers.get('content-type') ?? 'application/json' });
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) headers.set('retry-after', retryAfter);
    return new Response(response.body, { status: response.status, headers });
  } catch { return Response.json({ error: 'webhook service unavailable' }, { status: 502 }); }
}
