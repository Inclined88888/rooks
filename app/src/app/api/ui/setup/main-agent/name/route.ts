import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Conversational step 3 (`/api/setup/main-agent/name`): the wizard's browser session only. */
export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => ({}));
  return proxyJson('POST', '/api/setup/main-agent/name', body);
}
