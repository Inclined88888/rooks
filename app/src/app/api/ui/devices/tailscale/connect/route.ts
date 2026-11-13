import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sign the daemon's machine in to Tailscale (`tailscale up`).
 * The browser's body is not forwarded: no URL, account or command comes from here.
 */
export async function POST(): Promise<Response> {
  return proxyJson('POST', '/api/devices/tailscale/connect', {});
}
