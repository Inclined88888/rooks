import { LOCAL_MACHINE_ID } from '@/lib/machines/machine-id';
import { proxyBinary } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: { id: string } }): Promise<Response> {
  const rev = new URL(request.url).searchParams.get('rev');
  const query = rev ? `?rev=${encodeURIComponent(rev)}` : '';
  // The browser half of a plugin is always THIS computer's copy, even on a
  // remote machine: JavaScript served by another machine never runs on this
  // origin with the local session (`lib/plugin-host/remote-plugins.ts`).
  return proxyBinary(`/plugins/${encodeURIComponent(params.id)}/client.js${query}`, { machine: LOCAL_MACHINE_ID });
}
