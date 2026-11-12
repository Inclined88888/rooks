import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  return proxyJson('GET', `/api/project-todo/${encodeURIComponent(params.id)}/attachments`);
}

// Only the file crosses: name, base64 bytes and the browser's type, which the
// daemon treats as a hint. The daemon validates and bounds all three.
export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  const body = await req.json().catch(() => ({})) as { name?: unknown; data?: unknown; mime?: unknown };
  return proxyJson('POST', `/api/project-todo/${encodeURIComponent(params.id)}/attachments`, {
    name: body.name,
    data: body.data,
    ...(body.mime !== undefined ? { mime: body.mime } : {}),
  });
}
