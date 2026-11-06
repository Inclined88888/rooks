import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The model that names the signed-in account's conversations (TODO #358): its choice, the instance setting, the eligible backends. */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/mission-titles/model');
}

/** Body: { value: "auto" | "off" | { backend, model } | null } — null follows the instance setting again. */
export async function PUT(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('PUT', '/api/mission-titles/model', body);
}
