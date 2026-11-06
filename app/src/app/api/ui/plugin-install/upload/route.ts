/**
 * `POST /api/ui/plugin-install/upload` — a plugin archive picked in the
 * browser, forwarded as raw bytes to `/api/plugins/-/install/upload`
 * (TODO #332). Same size bound as the daemon, checked here first so a file
 * that would be refused is not shipped across.
 *
 * Auth: the `timon_session` cookie only — never the daemon token.
 */
import { PLUGIN_UPLOAD_MAX_BYTES } from '@/lib/plugin-install';
import { relay, sessionProxyHeaders } from '@/lib/ui/proxy';
import { htmlFailureAsJson } from '@/lib/ui/proxy-errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const tooLarge = (): Response => Response.json({ error: 'too-large' }, { status: 413 });

export async function POST(request: Request): Promise<Response> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > PLUGIN_UPLOAD_MAX_BYTES) return tooLarge();
  const body = await request.arrayBuffer();
  if (body.byteLength > PLUGIN_UPLOAD_MAX_BYTES) return tooLarge();
  const upstream = await relay('/api/plugins/-/install/upload', {
    method: 'POST',
    headers: { ...sessionProxyHeaders(), 'content-type': 'application/octet-stream' },
    body,
    cache: 'no-store',
  });
  const text = await upstream.text();
  const failure = htmlFailureAsJson(upstream.status, upstream.headers.get('content-type'), upstream.ok);
  return new Response(failure ? failure.body : text, {
    status: upstream.status,
    headers: {
      'content-type': failure ? 'application/json' : upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}
