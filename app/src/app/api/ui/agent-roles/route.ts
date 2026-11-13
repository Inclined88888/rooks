import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Agent roles (label, colour, icon, default directives) — NOT the permission
// roles of account administration, which a plugin serves.
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/agent-roles');
}

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', '/api/agent-roles', body);
}
