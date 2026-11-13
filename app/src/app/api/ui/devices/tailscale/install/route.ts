import { installProxyBody } from '@/lib/tailscale-setup';
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Install Tailscale the official way for the daemon's OS (`host/tailscale-install.ts`).
 * The browser's body is not forwarded: no URL, account or command comes from
 * here. One word passes, rebuilt here: that the desktop app asks, which can
 * open the installer when the daemon has no desktop.
 */
export async function POST(req: Request): Promise<Response> {
  return proxyJson('POST', '/api/devices/tailscale/install', installProxyBody(await req.json().catch(() => null)));
}
