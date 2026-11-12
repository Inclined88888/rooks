import { proxyJson } from '@/lib/ui/proxy';
import { streamBrowserDownload } from '@/lib/ui/native-browser-download';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function upstream(req: Request, path: string[]): string {
  return `/api/native-browser/${path.map(encodeURIComponent).join('/')}${new URL(req.url).search}`;
}

export async function GET(req: Request, { params }: { params: { path: string[] } }): Promise<Response> {
  if (params.path.length === 3 && params.path[1] === 'downloads') return streamBrowserDownload(req, params.path[0]!, params.path[2]!);
  return proxyJson('GET', upstream(req, params.path));
}

export async function DELETE(req: Request, { params }: { params: { path: string[] } }): Promise<Response> {
  return proxyJson('DELETE', upstream(req, params.path));
}

// An empty body is a legal call (`recording/start`, `recordings/:id/learn`): the daemon validates it.
async function readBody(req: Request): Promise<{ body: unknown } | Response> {
  const text = await req.text();
  if (!text.trim()) return { body: undefined };
  try { return { body: JSON.parse(text) as unknown }; }
  catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
}

export async function POST(req: Request, { params }: { params: { path: string[] } }): Promise<Response> {
  const read = await readBody(req);
  if (read instanceof Response) return read;
  return proxyJson('POST', upstream(req, params.path), read.body);
}

export async function PATCH(req: Request, { params }: { params: { path: string[] } }): Promise<Response> {
  const read = await readBody(req);
  if (read instanceof Response) return read;
  return proxyJson('PATCH', upstream(req, params.path), read.body);
}
