import { localTarget } from '@/lib/machines/target';
import { forwardHook, forwardHookQuery, PLUGIN_HOOK_SLUG_RE, PLUGIN_HOOK_NAME_RE } from '@/lib/trigger-hook-relay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: { plugin: string; name: string } };

/** The URL copied from a plugin's settings: same path on the app and the daemon.
 *  Always this app's own daemon, whatever machine a browser has switched to:
 *  the sender is an outside service, and the URL it was given names this host. */
export async function POST(req: Request, { params }: Params): Promise<Response> {
  // Same answer as the daemon for an unknown webhook: no oracle on what is installed.
  if (!PLUGIN_HOOK_SLUG_RE.test(params.plugin) || !PLUGIN_HOOK_NAME_RE.test(params.name)) {
    return Response.json({ error: 'authentication failed' }, { status: 401 });
  }
  return forwardHook(req, `${localTarget().url}/api/plugins/hooks/${params.plugin}/${params.name}`);
}

/** A sender's subscription check (Meta's `hub.challenge`), answered by the daemon alone. */
export async function GET(req: Request, { params }: Params): Promise<Response> {
  if (!PLUGIN_HOOK_SLUG_RE.test(params.plugin) || !PLUGIN_HOOK_NAME_RE.test(params.name)) {
    return Response.json({ error: 'authentication failed' }, { status: 401 });
  }
  return forwardHookQuery(req, `${localTarget().url}/api/plugins/hooks/${params.plugin}/${params.name}`);
}
