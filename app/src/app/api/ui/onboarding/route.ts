import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 1:1 proxy: the first-run screen ACTS — it installs the daemon service, or a
 *  missing prerequisite. The daemon accepts named actions only (never a
 *  command), refuses once `timon.config.json` exists, and answers with the
 *  exact command to paste when it could not run one itself (§5.7.3). */
export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  return proxyJson('POST', '/api/onboarding', body);
}
