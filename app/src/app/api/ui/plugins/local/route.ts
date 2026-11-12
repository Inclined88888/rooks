/**
 * `GET /api/ui/plugins/local` — the plugins of THIS computer's daemon, whatever
 * the active machine (TODO #329, P4d). On a remote machine, the client loader
 * and the gallery compare its list with the remote one: a third-party
 * plugin's browser half is mounted only from a local copy with the same
 * version and signature. Same answer as `/api/ui/plugins` on the local machine.
 */
import { LOCAL_MACHINE_ID } from '@/lib/machines/machine-id';
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/plugins', undefined, { machine: LOCAL_MACHINE_ID });
}
