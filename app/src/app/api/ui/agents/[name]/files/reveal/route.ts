import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Opens the folder in the host's file manager. The action runs on the
 *  orchestrator side (host mode): the app runs in a container and has no
 *  access to the graphical session. `client: 'desktop'` says the Electron app
 *  can show the path itself when the daemon has no desktop session; any other
 *  value is ignored. */
export async function POST(req: Request, { params }: { params: { name: string } }): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const { path: rawPath, client } = body as { path?: unknown; client?: unknown };
  const path = typeof rawPath === 'string' ? rawPath : '';
  return proxyJson('POST', `/api/agents/${encodeURIComponent(params.name)}/files/reveal`,
    client === 'desktop' ? { path, client } : { path });
}
