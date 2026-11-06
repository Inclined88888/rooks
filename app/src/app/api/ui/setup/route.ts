import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 1:1 proxy: writes `timon.config.json` on first run. The daemon refuses to
 *  overwrite an existing file unless `force`, and never restarts itself — it
 *  answers `restartRequired`, the gesture stays the user's. */
export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  return proxyJson('POST', '/api/setup', body);
}
