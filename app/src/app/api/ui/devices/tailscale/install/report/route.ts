import { installerReportProxyBody } from '@/lib/tailscale-setup';
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The desktop app's word on the installer it opened (`desktop/src/tailscale-installer.ts`).
 * Only the three fields the daemon reads are passed on; it validates them strictly.
 */
export async function POST(req: Request): Promise<Response> {
  return proxyJson('POST', '/api/devices/tailscale/install/report', installerReportProxyBody(await req.json().catch(() => null)));
}
