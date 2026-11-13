import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Tailscale on the daemon's machine: its state and the setup job in progress. */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/devices/tailscale');
}
