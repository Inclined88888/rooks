import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Linux: let the daemon's account drive Tailscale without sudo (`tailscale set --operator`, pkexec).
 * The browser's body is not forwarded: no URL, account or command comes from here.
 */
export async function POST(): Promise<Response> {
  return proxyJson('POST', '/api/devices/tailscale/operator', {});
}
