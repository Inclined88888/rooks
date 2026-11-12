import { proxyJson } from '@/lib/ui/proxy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** "Check for updates": the daemon reads the versions again before answering. */
export async function POST(): Promise<Response> {
  return proxyJson('POST', '/api/host/provider-clis/check', {});
}
