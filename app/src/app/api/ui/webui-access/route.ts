import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 1:1 proxy: how the web UI is reached, as seen FROM THE DAEMON'S MACHINE.
 *  The answer cannot be computed here — this route handler often runs inside
 *  the `rooks-app` container, whose only interface is the Docker bridge and
 *  where `tailscale` does not exist (`orchestrator/src/web-access.ts`). */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/webui-access');
}
