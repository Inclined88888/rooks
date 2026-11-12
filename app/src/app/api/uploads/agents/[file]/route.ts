import { proxyBinary } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Photos an agent set on another agent (`agent_set_avatar`): the daemon serves them, the browser reaches them here.
export async function GET(
  _req: Request,
  { params }: { params: { file: string } },
): Promise<Response> {
  return proxyBinary(`/api/uploads/agents/${encodeURIComponent(params.file)}`);
}
