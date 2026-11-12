import { proxyBinary, proxyJson } from '@/lib/ui/proxy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: { file: string } };
export async function GET(_req: Request, { params }: Context): Promise<Response> {
  const response = await proxyBinary(`/api/appearance/background-image/${encodeURIComponent(params.file)}`);
  response.headers.set('x-content-type-options', 'nosniff');
  return response;
}
export async function DELETE(_req: Request, { params }: Context): Promise<Response> {
  return proxyJson('DELETE', `/api/appearance/background-image/${encodeURIComponent(params.file)}`);
}
