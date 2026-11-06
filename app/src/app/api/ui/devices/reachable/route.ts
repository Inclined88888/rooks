import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Publish this machine's daemon on the tailnet (`tailscale serve`, never
 * `funnel`). The browser's body is not forwarded: the daemon picks the port
 * and the target, nothing here may suggest either.
 */
export async function POST(): Promise<Response> {
  return proxyJson('POST', '/api/devices/reachable', {});
}
