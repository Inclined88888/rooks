import { proxyBinary } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { file: string } },
): Promise<Response> {
  return proxyBinary(`/api/uploads/avatars/${encodeURIComponent(params.file)}`);
}
